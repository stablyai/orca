import { captureBotView, createFirstMobileBot } from './preview/mobile-bot-sheet-controls.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp,
  waitForRecordedRequests
} from './preview/mobile-web-app-render-harness.mjs'

// Real browser proves the host list draws a host's bots from its replies: the bot row with its mascot asset, its worker's workspace under it, and its folder gone from the projects.

const HOST_ROUTE = '/h/render-check-host'
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}

function psRow(overrides) {
  return {
    workspaceKind: 'git',
    repoId: 'repo-1',
    repo: 'acme-web',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unverifiableTerminalCount: 0,
    lastOutputAt: null,
    preview: '',
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

const BOT_HOME = psRow({
  workspaceKind: 'folder-workspace',
  worktreeId: 'folder:atlas-home',
  repoId: 'folder-workspace:bots-group',
  repo: 'Bots',
  path: '/Users/me/.orca/bots/atlas',
  branch: '',
  displayName: 'atlas'
})
const WORKER = psRow({
  worktreeId: 'repo-1::/repo/flaky',
  path: '/repo/flaky',
  branch: 'fix-flaky-login-test',
  displayName: 'fix-flaky-login-test'
})
const PLAIN = psRow({
  worktreeId: 'repo-1::/repo/main',
  path: '/repo/main',
  branch: 'main',
  displayName: 'main-checkout',
  isMainWorktree: true
})

// A worker alone in its own project: once the bot lists it, that project has nothing left to show.
const LONE_WORKER = psRow({
  worktreeId: 'repo-2::/repo/lone',
  repoId: 'repo-2',
  repo: 'lone-project',
  path: '/repo/lone',
  branch: 'lone-worker-branch',
  displayName: 'lone-worker'
})

function workerLink(worktreeId) {
  return {
    childWorkspaceKey: `worktree:${worktreeId}`,
    parentWorkspaceKey: 'folder:atlas-home',
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    createdAt: 1
  }
}

function replies(capabilities, botsEnabled = true, extraWorkers = []) {
  return {
    'status.get': {
      protocolVersion: 5,
      minCompatibleMobileVersion: 1,
      appVersion: '1.4.200',
      capabilities
    },
    'worktree.ps': { worktrees: [BOT_HOME, WORKER, PLAIN, ...extraWorkers] },
    // The host's projects, which draw an empty project as a placeholder section.
    'repo.list': {
      repos: [
        { id: 'repo-1', displayName: 'acme-web', path: '/repo' },
        { id: 'repo-2', displayName: 'lone-project', path: '/repo-2' }
      ]
    },
    'bots.list': {
      botsEnabled,
      hideBotCreatedWorkspaces: true,
      bots: [
        {
          id: 'bot-1',
          name: 'Atlas',
          hostId: 'local',
          folder: 'atlas',
          folderWorkspaceId: 'atlas-home',
          agent: 'codex',
          avatar: 'mascot:A1',
          paused: false,
          notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
          members: [],
          slack: null,
          linear: null,
          github: null,
          chatSessionId: null,
          createdAt: 1,
          updatedAt: 1
        }
      ]
    },
    'bots.groups.list': { groups: [] },
    'worktree.lineageList': {
      lineage: {},
      workspaceLineage: Object.fromEntries(
        [WORKER, ...extraWorkers].map((row) => [
          `worktree:${row.worktreeId}`,
          workerLink(row.worktreeId)
        ])
      )
    }
  }
}

const bundles = mobileWebAppDependenciesPresent()
const describeRender = bundles ? describe : describe.skip

let scratch
let server
let browser
let origin
let cspHeader = null
let bridgeVersion = null
let faultGrant = null

beforeAll(async () => {
  if (!bundles) {
    return
  }
  cspHeader = await readShellCsp()
  bridgeVersion = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-bots-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openHostList(capabilities, botsEnabled, extraWorkers, scene) {
  const page = await browser.newPage({
    viewport: scene?.viewport ?? { width: 390, height: 844 },
    colorScheme: scene?.theme ?? 'light'
  })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'render-check-session',
    buildId: 'render-check-build',
    route: { pathname: HOST_ROUTE },
    host: SHELL_HOST,
    storage: {},
    colorScheme: scene?.theme ?? 'light',
    faultGrant,
    grants: [faultGrant, 'navigate', 'storage', 'haptics'],
    pageRoutes: ['/h/[hostId]'],
    replies: scene?.replies ?? replies(capabilities, botsEnabled, extraWorkers)
  })
  const errors = []
  const images = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname
    if (response.status() === 200 && path.endsWith('.webp')) {
      images.push(path)
    }
  })
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
    timeout: 30_000,
    polling: 250
  })
  await page.waitForFunction(() => document.body.innerText.includes('main-checkout'), {
    timeout: 30_000,
    polling: 250
  })
  return { page, errors, images }
}

describeRender('the host list draws a host’s bots in a real browser', () => {
  it('lists the bot with its mascot and its worker’s workspace, and takes both out of the projects', async () => {
    const opened = await openHostList(['bots.mobile.v1'])
    await opened.page.waitForFunction(() => document.body.innerText.includes('Atlas'), {
      timeout: 30_000,
      polling: 250
    })
    const text = await opened.page.evaluate(() => document.body.innerText)
    const order = (needle) => text.indexOf(needle)
    // The section, the bot, then its line, all above the project that held the line.
    // Section headers draw uppercase.
    expect(order('Bots')).toBeGreaterThan(-1)
    expect(order('Atlas')).toBeGreaterThan(order('Bots'))
    expect(order('fix-flaky-login-test')).toBeGreaterThan(order('Atlas'))
    expect(order('main-checkout')).toBeGreaterThan(order('fix-flaky-login-test'))
    // The folder row and its Folder tag are gone: the bot row draws the home.
    expect(text).not.toContain('.orca/bots/atlas')
    expect(text).not.toContain('Folder')
    await expect.poll(() => opened.images.length).toBeGreaterThan(0)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('plans the projects without the bot’s rows, so a project holding only a worker never shows', async () => {
    const opened = await openHostList(['bots.mobile.v1'], true, [LONE_WORKER])
    await opened.page.waitForFunction(() => document.body.innerText.includes('lone-worker'), {
      timeout: 30_000,
      polling: 250
    })
    const text = await opened.page.evaluate(() => document.body.innerText)
    // Project identity remains on the worker; the empty project header is omitted.
    expect(text.indexOf('lone-worker')).toBeGreaterThan(text.indexOf('Atlas'))
    expect(text.match(/lone-project/g)).toHaveLength(1)
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('keeps the shared collapse control and real avatars usable with zero, four and eight bots in both themes', async () => {
    for (const theme of ['light', 'dark']) {
      for (const count of [0, 4, 8]) {
        const answer = replies(['bots.mobile.v1', 'bots.create.v1'])
        const bot = answer['bots.list'].bots[0]
        answer['bots.list'].bots = Array.from({ length: count }, (_, index) => ({
          ...bot,
          id: `bot-${index}`,
          name: index === 0 ? 'Atlas' : `Bot ${index}`,
          folderWorkspaceId: `home-${index}`,
          avatar: `mascot:${['A1', 'B1', 'G1', 'H1', 'J1', 'M1', 'O1', 'T1'][index]}`,
          paused: index === 7
        }))
        answer['worktree.ps'].worktrees = [
          PLAIN,
          ...answer['bots.list'].bots.map((entry, index) => ({
            ...BOT_HOME,
            worktreeId: `folder:${entry.folderWorkspaceId}`,
            displayName: entry.name,
            unread: index < 7,
            sidebarStatus: index < 2 ? 'permission' : index < 4 ? 'working' : 'inactive'
          }))
        ]
        answer['bots.upNext.unseen'] = {
          unseen: Object.fromEntries(answer['bots.list'].bots.map((entry) => [entry.id, 10]))
        }
        answer['ui.set'] = {}
        const { page, errors } = await openHostList([], undefined, undefined, {
          theme,
          replies: answer
        })
        const toggle = page.getByRole('button', { name: new RegExp(`^Bots, ${count} bots,`) })
        await toggle.waitFor()
        expect(await toggle.getAttribute('aria-expanded')).toBe('true')
        await captureBotView(page, `mobile-${count}-expanded-${theme}`)
        if (count === 0) {
          await createFirstMobileBot(page, bot, BOT_HOME)
          expect(errors).toEqual([])
          await page.close()
          continue
        }
        await toggle.click()
        await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('false')
        if (count === 8) {
          expect(await toggle.innerText()).toContain('+3')
          // Seven homes are unread; every bot's new Up next counts on its row, never as unread.
          expect(await toggle.getAttribute('aria-label')).toContain('7 unread')
        }
        await captureBotView(page, `mobile-${count}-collapsed-${theme}`)
        await page.getByRole('button', { name: 'New bot', exact: true }).waitFor()
        await page.setViewportSize({ width: 180, height: 844 })
        await captureBotView(page, `mobile-${count}-narrow-${theme}`)
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= 180)).toBe(true)
        await toggle.click()
        await expect.poll(() => toggle.getAttribute('aria-expanded')).toBe('true')
        const writes = await waitForRecordedRequests(page, ['ui.set'])
        expect(writes.some((request) => request.method === 'ui.set')).toBe(true)
        expect(errors).toEqual([])
        await page.close()
      }
    }
  }, 120_000)

  it('lists a group among its bots in Bots, as the desktop does, with no section of its own', async () => {
    const answer = replies(['bots.mobile.v1', 'bots.groups.v1'])
    answer['bots.list'].bots[0].sidebarOrder = 1
    answer['bots.groups.list'] = {
      groups: [
        {
          id: 'group-1',
          name: 'Review crew',
          hostId: 'local',
          revision: 1,
          folder: 'group-review',
          folderWorkspaceId: 'review-home',
          createdAt: 2,
          members: [{ botId: 'bot-1', sessionId: 'member-1' }],
          replyMode: { kind: 'all' },
          sidebarOrder: 0
        }
      ]
    }
    answer['worktree.ps'].worktrees.push({
      ...BOT_HOME,
      worktreeId: 'folder:review-home',
      path: '/Users/me/.orca/bots/group-review',
      displayName: 'review'
    })
    const opened = await openHostList([], undefined, undefined, { replies: answer })
    await opened.page.waitForFunction(() => document.body.innerText.includes('Review crew'), {
      timeout: 30_000,
      polling: 250
    })
    const text = await opened.page.evaluate(() => document.body.innerText)
    // A drag placed the group first, then Atlas; the Bots header counts both.
    expect(text.indexOf('Review crew')).toBeGreaterThan(text.indexOf('Bots'))
    expect(text.indexOf('Atlas')).toBeGreaterThan(text.indexOf('Review crew'))
    expect(text).not.toContain('Groups')
    expect(text).not.toContain('group-review')
    await opened.page.getByRole('button', { name: /^Bots, 1 bots,/ }).waitFor()
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('opens a bot home, a worker and an ordinary workspace through their existing navigation controls', async () => {
    for (const [label, id] of [
      ['Atlas', 'folder:atlas-home'],
      ['fix-flaky-login-test', WORKER.worktreeId],
      ['main-checkout', PLAIN.worktreeId]
    ]) {
      const { page, errors } = await openHostList(['bots.mobile.v1'])
      if (label === 'Atlas') {
        await page.getByRole('button', { name: /^Hide Atlas/ }).click()
        await expect
          .poll(() => page.getByText('fix-flaky-login-test', { exact: true }).count())
          .toBe(0)
        await page.getByRole('button', { name: /^Show Atlas/ }).click()
      }
      await page.getByText(label, { exact: true }).first().click()
      await expect
        .poll(() =>
          page.evaluate(() =>
            globalThis.__orcaRenderCheckNotifies.some((frame) =>
              JSON.stringify(frame).includes('session')
            )
          )
        )
        .toBe(true)
      const notifies = await page.evaluate(() => globalThis.__orcaRenderCheckNotifies)
      expect(JSON.stringify(notifies)).toContain(encodeURIComponent(id))
      const requests = await waitForRecordedRequests(page, ['worktree.activate'])
      expect(
        JSON.stringify(requests.find((request) => request.method === 'worktree.activate').params)
      ).toContain(id)
      expect(errors).toEqual([])
      await page.close()
    }
  }, 60_000)

  it('leaves the bot homes as folders while the host has bots switched off', async () => {
    const opened = await openHostList(['bots.mobile.v1'], false)
    await waitForRecordedRequests(opened.page, ['bots.list'])
    await opened.page.waitForFunction(() => document.body.innerText.includes('atlas'), {
      timeout: 30_000,
      polling: 250
    })
    // Give the list a frame after the reply, then confirm the bot never took over its folder.
    await opened.page.waitForTimeout(500)
    expect(await opened.page.evaluate(() => document.body.innerText)).not.toContain('Atlas')
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)

  it('keeps the plain folder rows and asks for no bots from a host without the capability', async () => {
    const opened = await openHostList([])
    await opened.page.waitForFunction(() => document.body.innerText.includes('atlas'), {
      timeout: 30_000,
      polling: 250
    })
    const requests = await waitForRecordedRequests(opened.page, ['worktree.ps'])
    expect(requests.map((request) => request.method)).not.toContain('bots.list')
    const text = await opened.page.evaluate(() => document.body.innerText)
    expect(text).not.toContain('Atlas')
    expect(opened.errors).toEqual([])
    await opened.page.close()
  }, 60_000)
})
