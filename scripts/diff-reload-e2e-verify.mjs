#!/usr/bin/env node
/**
 * E2E verification for diff tree file watcher (#4730).
 * Drives Orca via CDP (connectOverCDP) — never navigates away from the page.
 */
import { chromium } from 'playwright'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { realpathSync } from 'node:fs'

const CDP_PORT = Number(process.env.CDP_PORT ?? 9338)
const WORKTREE_PATH = realpathSync(
  process.env.E2E_WORKTREE_PATH ??
    '/Users/jinwoohong/orca/workspaces/orca-diff-e2e-verify.7VkMjm/e2e-verify-1780718846708'
)
const REPO_PATH = realpathSync(process.env.E2E_REPO_PATH ?? '/tmp/orca-diff-e2e-verify.7VkMjm')
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? '/tmp/diff-reload-e2e'

const results = []
let activeWorktreeId = ''

function record(name, pass, detail) {
  results.push({ name, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? `: ${detail}` : ''}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function getMonacoText(page) {
  return page.evaluate(() => {
    const views = document.querySelectorAll('.monaco-editor .view-lines')
    return Array.from(views).map((v) => v.textContent ?? '')
  })
}

async function getStore(page) {
  return page.evaluate(() => {
    const s = window.__store.getState()
    return {
      activeWorktreeId: s.activeWorktreeId,
      openFiles: s.openFiles.map((f) => ({
        id: f.id,
        relativePath: f.relativePath,
        mode: f.mode,
        diffSource: f.diffSource,
        nonce: f.diffContentReloadNonce
      })),
      activeTab: s.activeTabTypeByWorktree?.[s.activeWorktreeId]
    }
  })
}

async function activateWorktree(page) {
  await page.waitForFunction(
    () => window.__store?.getState().workspaceSessionReady === true,
    null,
    {
      timeout: 60_000
    }
  )
  const worktreeId = await page.evaluate(
    async ({ repoPath, worktreePath }) => {
      let state = window.__store.getState()
      let repo = state.repos.find((r) => r.path === repoPath)
      if (!repo) {
        await window.api.repos.add({ path: repoPath })
        await state.fetchRepos()
        state = window.__store.getState()
        repo = state.repos.find((r) => r.path === repoPath)
      }
      if (!repo) {
        throw new Error(`repo not found at ${repoPath}`)
      }
      await state.updateRepo(repo.id, { externalWorktreeVisibility: 'show' })
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await state.fetchWorktrees(repo.id)
        state = window.__store.getState()
        const worktrees = state.worktreesByRepo[repo.id] ?? []
        const normalize = (p) => p.replace(/^\/tmp\//, '/private/tmp/')
        const wt = worktrees.find(
          (w) => w.path === worktreePath || normalize(w.path) === normalize(worktreePath)
        )
        if (wt) {
          state.setActiveWorktree(wt.id)
          state.setActiveView('editor')
          return wt.id
        }
        await new Promise((r) => setTimeout(r, 500))
      }
      const listed = (window.__store.getState().worktreesByRepo[repo.id] ?? []).map((w) => w.path)
      throw new Error(`worktree not found at ${worktreePath}; saw: ${listed.join(', ')}`)
    },
    { repoPath: REPO_PATH, worktreePath: WORKTREE_PATH }
  )
  activeWorktreeId = worktreeId
  console.log('Active worktree:', worktreeId)
  await sleep(1000)
  return worktreeId
}

async function clickVisibleScFileRow(page, fileName) {
  const clicked = await page.evaluate(
    ({ fileName }) => {
      const row = [...document.querySelectorAll('div[class*="cursor-pointer"]')].find(
        (el) =>
          el.textContent?.includes(fileName) &&
          el.offsetParent !== null &&
          !el.closest('[role="tablist"]')
      )
      if (!row) {
        return false
      }
      row.click()
      return true
    },
    { fileName }
  )
  if (!clicked) {
    throw new Error(`Could not click visible SC row for ${fileName}`)
  }
  await sleep(800)
}

async function openUnstagedDiff(page, fileName) {
  await clickVisibleScFileRow(page, fileName)
}

async function openStagedDiff(page, fileName) {
  await clickVisibleScFileRow(page, fileName)
}

async function openAllChanges(page) {
  await page.evaluate(
    async ({ worktreePath }) => {
      const s = window.__store.getState()
      const wt = Object.values(s.worktreesByRepo)
        .flatMap((obj) => Object.values(obj))
        .find((w) => w.path === worktreePath)
      if (!wt) {
        throw new Error('worktree missing')
      }
      s.openAllDiffs(wt.id, worktreePath)
      s.setActiveView('editor')
    },
    { worktreePath: WORKTREE_PATH }
  )
  await sleep(1000)
}

async function waitForMonacoContains(page, text, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const texts = await getMonacoText(page)
    const joined = texts.join('\n')
    if (joined.includes(text)) {
      return true
    }
    await sleep(200)
  }
  return false
}

async function main() {
  mkdirSync(SCREENSHOT_DIR, { recursive: true })
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`)
  const page = browser.contexts()[0]?.pages()[0]
  if (!page) {
    throw new Error('No page found')
  }

  const identity = JSON.parse(
    await page.evaluate(async () => JSON.stringify(await window.api.app.getIdentity()))
  )
  console.log('Identity:', JSON.stringify(identity))
  if (!identity.devLabel?.includes('diff-tree-file-watcher')) {
    throw new Error(`Wrong Orca instance: ${identity.devLabel ?? identity.name}`)
  }

  // Setup: activate worktree, open source control
  await activateWorktree(page)
  await page.evaluate(() => {
    const s = window.__store.getState()
    s.setRightSidebarOpen(true)
    s.setRightSidebarTab('source-control')
  })
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('button, [role="button"]')].some(
        (el) => (el.textContent ?? '').includes('Changes') && el.offsetParent !== null
      ),
    null,
    { timeout: 15_000 }
  )
  await sleep(500)

  const alphaPath = join(WORKTREE_PATH, 'alpha.txt')
  const betaPath = join(WORKTREE_PATH, 'beta.txt')

  // --- Test 1: Unstaged diff loads ---
  writeFileSync(betaPath, 'beta-load-test-v1\n')
  await sleep(300)
  await openUnstagedDiff(page, 'beta.txt')
  const t1 = await waitForMonacoContains(page, 'beta-load-test-v1')
  record('1. Unstaged diff loads', t1, t1 ? 'showed beta-load-test-v1' : 'content missing')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/01-unstaged-load.png` })

  // --- Test 2: External edit on focused unstaged diff ---
  writeFileSync(betaPath, 'beta-external-v2\n')
  await sleep(1000)
  const t2 = await waitForMonacoContains(page, 'beta-external-v2')
  record(
    '2. External edit on focused unstaged diff',
    t2,
    t2 ? 'updated to beta-external-v2' : 'stale content'
  )
  await page.screenshot({ path: `${SCREENSHOT_DIR}/02-external-edit-unstaged.png` })

  // --- Test 3: Re-click file in Source Control ---
  writeFileSync(betaPath, 'beta-reclick-v3\n')
  await sleep(200)
  // Switch away so the re-click is a true re-open, not a no-op focus.
  await openStagedDiff(page, 'alpha.txt')
  await sleep(500)
  await openUnstagedDiff(page, 'beta.txt')
  const store3 = await getStore(page)
  const betaNonce = store3.openFiles.find(
    (f) => f.relativePath === 'beta.txt' && f.mode === 'diff' && f.diffSource === 'unstaged'
  )?.nonce
  const t3content = await waitForMonacoContains(page, 'beta-reclick-v3')
  const t3 = t3content
  record(
    '3. Re-click file in Source Control',
    t3,
    t3 ? `showed beta-reclick-v3 (nonce=${betaNonce ?? 0})` : `stale (nonce=${betaNonce ?? 0})`
  )
  await page.screenshot({ path: `${SCREENSHOT_DIR}/03-reclick-sc.png` })

  // --- Test 4: Staged diff tab opens ---
  writeFileSync(alphaPath, 'alpha-staged-v4\n')
  execSync('git add alpha.txt', { cwd: WORKTREE_PATH })
  await sleep(500)
  await openStagedDiff(page, 'alpha.txt')
  await sleep(500)
  const store4 = await getStore(page)
  const hasStagedTab = store4.openFiles.some(
    (f) => f.relativePath === 'alpha.txt' && f.diffSource === 'staged'
  )
  const t4 = hasStagedTab && (await waitForMonacoContains(page, 'alpha-staged-v4'))
  record('4. Staged diff tab opens', t4, t4 ? 'staged tab + content' : 'failed')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/04-staged-diff.png` })

  // --- Test 5: Git status reload after git add (no fs event on unstaged tab) ---
  // Reset alpha to staged baseline, modify beta, open unstaged beta diff
  writeFileSync(betaPath, 'beta-gitstatus-v5\n')
  await openUnstagedDiff(page, 'beta.txt')
  await sleep(500)
  // Stage beta via git
  execSync('git add beta.txt', { cwd: WORKTREE_PATH })
  await sleep(1500)
  // Unstaged diff should show empty or reload; open staged diff for beta
  await page.evaluate(
    async ({ worktreePath }) => {
      const s = window.__store.getState()
      const wt = Object.values(s.worktreesByRepo)
        .flatMap((obj) => Object.values(obj))
        .find((w) => w.path === worktreePath)
      s.openDiff(wt.id, worktreePath, 'beta.txt', 'plaintext', true)
    },
    { worktreePath: WORKTREE_PATH }
  )
  await sleep(1000)
  const t5 = await waitForMonacoContains(page, 'beta-gitstatus-v5')
  record('5. Git status reload (staged beta after git add)', t5, t5 ? 'staged shows v5' : 'stale')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/05-git-status-reload.png` })

  // Unstage for combined tests
  execSync('git reset HEAD beta.txt', { cwd: WORKTREE_PATH })
  writeFileSync(betaPath, 'beta-combined-v6\n')

  // --- Test 6: Combined All Changes loads ---
  await openAllChanges(page)
  await sleep(1500)
  // Expand beta section if collapsed
  const betaTreeBtn = page.locator('button').filter({ hasText: /^beta\.txt$/ })
  if (
    await betaTreeBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await betaTreeBtn.first().click()
    await sleep(500)
  }
  const t6 = await waitForMonacoContains(page, 'beta-combined-v6')
  record('6. Combined All Changes loads', t6, t6 ? 'shows beta-combined-v6' : 'stale')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/06-combined-load.png` })

  // --- Test 7: Combined external watch ---
  writeFileSync(betaPath, 'beta-combined-ext-v7\n')
  await sleep(1500)
  const t7 = await waitForMonacoContains(page, 'beta-combined-ext-v7')
  record('7. Combined external file watch', t7, t7 ? 'updated to v7' : 'stale after 1.5s')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/07-combined-external.png` })

  // --- Test 8: Combined tree re-click reload ---
  writeFileSync(betaPath, 'beta-combined-reclick-v8\n')
  await sleep(200)
  if (
    await betaTreeBtn
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    await betaTreeBtn.first().click()
    await sleep(1000)
  }
  const t8 = await waitForMonacoContains(page, 'beta-combined-reclick-v8')
  record('8. Combined tree re-click reload', t8, t8 ? 'showed v8' : 'stale')
  await page.screenshot({ path: `${SCREENSHOT_DIR}/08-combined-reclick.png` })

  // --- Test 9: Re-open existing diff tab (nonce bump) ---
  writeFileSync(betaPath, 'beta-nonce-v9\n')
  await sleep(200)
  const nonceBefore = await page.evaluate(
    async ({ worktreeId, worktreePath }) => {
      const store = window.__store
      const findBeta = () =>
        store
          .getState()
          .openFiles.find(
            (f) => f.relativePath === 'beta.txt' && f.mode === 'diff' && f.diffSource === 'unstaged'
          )
      store.getState().openDiff(worktreeId, worktreePath, 'beta.txt', 'plaintext', false)
      const firstNonce = findBeta()?.diffContentReloadNonce ?? 0
      store.getState().openDiff(worktreeId, worktreePath, 'beta.txt', 'plaintext', false)
      const secondNonce = findBeta()?.diffContentReloadNonce ?? 0
      return { before: firstNonce, after: secondNonce }
    },
    { worktreeId: activeWorktreeId, worktreePath: WORKTREE_PATH }
  )
  await sleep(1000)
  const t9content = await waitForMonacoContains(page, 'beta-nonce-v9')
  const t9 = t9content && nonceBefore.after > nonceBefore.before
  record(
    '9. Re-open diff tab (nonce bump)',
    t9,
    t9
      ? `nonce ${nonceBefore.before}->${nonceBefore.after}, content=v9`
      : `nonce ${nonceBefore.before}->${nonceBefore.after}, content=${t9content ? 'ok' : 'stale'}`
  )
  await page.screenshot({ path: `${SCREENSHOT_DIR}/09-nonce-reopen.png` })

  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length
  console.log(`\n=== SUMMARY: ${passed} passed, ${failed} failed ===`)
  if (failed > 0) {
    console.log(
      'Failures:',
      results.filter((r) => !r.pass).map((r) => r.name)
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
