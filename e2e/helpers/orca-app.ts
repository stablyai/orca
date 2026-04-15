/**
 * Shared Electron fixture for Orca E2E tests.
 *
 * Why: Playwright's native _electron.launch() is used instead of CDP.
 * It launches the Electron app directly from the built output, gives
 * full access to the BrowserWindow, and handles lifecycle automatically.
 * No need to manually start the app or pass --remote-debugging-port.
 *
 * Why: the fixture adds a dedicated test repo to the app so tests are
 * idempotent — they don't depend on whatever the user has open.
 *
 * Prerequisites:
 *   electron-vite build must have run first (globalSetup handles this).
 */

import { test as base, _electron as electron, type Page, type ElectronApplication } from '@stablyai/playwright-test'
import { readFileSync } from 'fs'
import path from 'path'
import { TEST_REPO_PATH_FILE } from '../global-setup'

type OrcaWorkerFixtures = {
  electronApp: ElectronApplication
  sharedPage: Page
  /** Absolute path to the test git repo created by globalSetup. */
  testRepoPath: string
}

export type OrcaFixtures = {
  orcaPage: Page
}

/**
 * Extended Playwright test with Orca-specific fixtures.
 *
 * `orcaPage` — the main Orca renderer window.
 *
 * Worker-scoped: a single Electron instance is shared across all tests
 * (workers: 1, fullyParallel: false in config).
 */
export const test = base.extend<OrcaFixtures, OrcaWorkerFixtures>({
  // Worker-scoped: read the test repo path once
  testRepoPath: [async ({}, use) => {
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
    await use(repoPath)
  }, { scope: 'worker' }],

  // Worker-scoped: one Electron app for the entire test run
  electronApp: [async ({}, use) => {
    const mainPath = path.join(process.cwd(), 'out', 'main', 'index.js')
    const app = await electron.launch({
      args: [mainPath],
      // Why: keep NODE_ENV=development so window.__store is exposed and
      // dev-only helpers (like configureDevUserDataPath) activate, isolating
      // test runs from the user's real Orca data directory.
      // Why: ORCA_E2E_HEADLESS suppresses mainWindow.show() so the app
      // window stays hidden during test runs, avoiding focus stealing and
      // screen clutter. Playwright interacts via CDP regardless.
      // Why: ORCA_E2E_HEADLESS suppresses mainWindow.show() for CI/headless
      // runs. ORCA_E2E_HEADFUL overrides this for tests that need a visible
      // window (e.g. pointer-capture drag tests).
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ...(process.env.ORCA_E2E_HEADFUL ? {} : { ORCA_E2E_HEADLESS: '1' }),
      },
    })
    await use(app)
    await app.close()
  }, { scope: 'worker' }],

  // Worker-scoped: grab the first BrowserWindow, add the test repo, and
  // wait until the session is fully ready with a worktree active.
  sharedPage: [async ({ electronApp, testRepoPath }, use) => {
    // Why: the Electron app may take a while to create the first window,
    // especially on cold start with no prior dev userData. 60s is generous.
    const page = await electronApp.firstWindow({ timeout: 60_000 })
    await page.waitForLoadState('domcontentloaded')

    // Wait for the store to be available
    await page.waitForFunction(
      () => !!(window as any).__store,
      null,
      { timeout: 30_000 }
    )

    // Add the test repo via the IPC bridge
    // Why: calling window.api.repos.add() goes through the same code path as
    // the "Add Repo" UI flow, ensuring worktrees are fetched and the session
    // initializes properly.
    await page.evaluate(async (repoPath) => {
      await (window as any).api.repos.add({ path: repoPath })
    }, testRepoPath)

    // Fetch repos in the renderer store so it picks up the new repo
    await page.evaluate(async () => {
      const store = (window as any).__store
      if (!store) return
      await store.getState().fetchRepos()
    })

    // Wait for the repo to appear and fetch its worktrees
    await page.evaluate(async () => {
      const store = (window as any).__store
      if (!store) return
      const repos = store.getState().repos
      for (const repo of repos) {
        await store.getState().fetchWorktrees(repo.id)
      }
    })

    // Activate the test repo's main worktree
    await page.evaluate((repoPath: string) => {
      const store = (window as any).__store
      if (!store) return
      const state = store.getState()
      const allWorktrees = Object.values(state.worktreesByRepo).flat() as any[]
      // Why: the test repo's worktree path will start with the test repo
      // directory. Find it by path prefix.
      const testWorktree = allWorktrees.find(
        (wt: any) => wt.path && wt.path.startsWith(repoPath)
      )
      if (testWorktree) {
        state.setActiveWorktree(testWorktree.id)
      }
    }, testRepoPath)

    // Wait for workspaceSessionReady to become true
    await page.waitForFunction(
      () => {
        const store = (window as any).__store
        return store?.getState().workspaceSessionReady === true
      },
      null,
      { timeout: 30_000 }
    )

    // Wait for at least one terminal to be visible in the test worktree
    // Why: use polling for any visible xterm rather than .first().waitFor()
    // which may pick a hidden element from another worktree.
    await page.waitForFunction(
      () => {
        const xterms = document.querySelectorAll('.xterm')
        return Array.from(xterms).some(
          (x) => (x as HTMLElement).offsetParent !== null
        )
      },
      null,
      { timeout: 15_000 }
    )

    await use(page)
  }, { scope: 'worker' }],

  // Test-scoped: each test gets the shared page
  orcaPage: async ({ sharedPage }, use) => {
    await use(sharedPage)
  },
})

export { expect } from '@stablyai/playwright-test'
