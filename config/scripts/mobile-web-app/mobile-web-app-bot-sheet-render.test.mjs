import { openMobileBotSheet, captureBotView } from './preview/mobile-bot-sheet-controls.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build/mobile-web-app/build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import { MOBILE_WEB_PAGE_ROUTES } from '../build/mobile-web-app/mobile-web-page-routes.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp,
  waitForRecordedRequests
} from './preview/mobile-web-app-render-harness.mjs'

// Real browser proves a bot's home chat draws the bot's header, and its sheet draws the host's Activity, Automations and Settings and writes back through the phone routes.

const HOST_ROUTE = '/h/render-check-host'
const SESSION_PATTERN = '/h/[hostId]/session/[worktreeId]'
const BOT_HOME_ROUTE = `${HOST_ROUTE}/session/${encodeURIComponent('folder:atlas-home')}`
const SHELL_HOST = {
  id: 'render-check-host',
  name: 'Render Check Host',
  endpoint: 'ws://render-check',
  lastConnected: 1
}

function sessionGrants() {
  const declared = MOBILE_WEB_PAGE_ROUTES.find((route) => route.pathname === SESSION_PATTERN)
  if (!declared) {
    throw new Error(`${SESSION_PATTERN} is not registered`)
  }
  return declared.grants
}

const BOT = {
  id: 'bot-1',
  name: 'Atlas',
  hostId: 'local',
  folder: 'atlas',
  folderWorkspaceId: 'atlas-home',
  agent: 'codex',
  avatar: 'mascot:A1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [{ id: 'U1', name: 'Dana Kim', source: 'slack' }],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat-1',
  createdAt: 1,
  updatedAt: 1
}

function automation(overrides) {
  return {
    id: 'auto-1',
    name: 'Morning digest',
    enabled: true,
    nextRunAt: 2,
    updatedAt: 1,
    dtstart: 1,
    rrule: 'FREQ=HOURLY;BYMINUTE=5',
    workspaceId: 'folder:atlas-home',
    ...overrides
  }
}

function replies(capabilities) {
  return {
    'status.get': {
      protocolVersion: 5,
      minCompatibleMobileVersion: 1,
      appVersion: '1.4.200',
      capabilities
    },
    'bots.list': { botsEnabled: true, hideBotCreatedWorkspaces: true, bots: [BOT] },
    'bots.activity': {
      activity: {
        workers: [
          {
            kind: 'worker',
            key: 'w1',
            dispatchId: 'd1',
            title: 'fix-flaky-login-test',
            dot: 'working',
            origin: { kind: 'chat' },
            paneKey: null,
            workspaceId: null,
            at: 1,
            worker: null
          }
        ],
        inProgress: [],
        completed: [
          {
            kind: 'run',
            key: 'r1',
            automationId: 'auto-1',
            automationName: 'Morning digest',
            runId: 'run-1',
            status: 'dispatch_failed',
            sessionId: null,
            dot: null,
            at: 1
          }
        ],
        waits: [],
        // The host composes the bot's own automations, so the phone reads no automation list.
        automations: [
          { key: 'auto-1', failing: false, automation: automation({}) },
          {
            key: 'auto-3',
            failing: false,
            // Its Slack event can't reach a bot with no Slack connector.
            automation: automation({
              id: 'auto-3',
              name: 'Deploy pings',
              dtstart: Date.UTC(9999, 0, 1),
              bot: { botId: 'bot-1', runsIn: 'new', resultsTo: 'chat' },
              on: [{ id: 'r1', source: 'slack', event: 'mentioned' }]
            })
          }
        ]
      }
    },
    'bots.update': {
      bot: { ...BOT, notifications: { ...BOT.notifications, taskComplete: false } }
    }
  }
}

const worker = (key, title, state, extra = {}) => ({
  key,
  title,
  state,
  startedAt: Date.now() - 600_000,
  ...(state === 'done' || state === 'failed' ? { settledAt: Date.now() - 60_000 } : {}),
  worktreeId: `wt-${key}`,
  dispatchId: `d-${key}`,
  ...extra
})

const chat = (chatId, title, origin, extra = {}) => ({
  chatId,
  title,
  origin,
  live: 'idle',
  lastActiveAt: Date.now() - 300_000,
  unread: false,
  closed: false,
  running: [],
  runningTotal: 0,
  finished: [],
  finishedTotal: 0,
  failedTotal: 0,
  ...extra
})

// A normal day: Home with work under it, a Slack thread waiting on the owner, a side chat replying, a finished one.
const CHAT_TREE = {
  chats: [
    chat('old', 'Tidy the release checklist', 'side', {
      finished: [
        worker('old-1', 'checklist-cleanup', 'done'),
        worker('old-2', 'docs-pass', 'done')
      ],
      finishedTotal: 3
    }),
    chat('draft', 'Draft the 1.4.230 release notes', 'side', { live: 'replying' }),
    chat('slack-1', 'Why ux-designer didn’t reply', 'slack', {
      originLabel: '#ui-ux-design',
      live: 'needs-you',
      running: [worker('fix', 'Fix ux-designer reply routing', 'running')],
      runningTotal: 1
    }),
    chat('chat-1', 'Home Chat', 'home', {
      preview: 'Filed 2 bug reports',
      running: [
        worker('phone', 'Phone: one Bots list across computers', 'running'),
        worker('relay', 'Paired bots PR 6: relay auth', 'needs-you', { paneKey: 'tab:relay' })
      ],
      runningTotal: 2,
      finished: [
        worker('scopes', 'Check ux-designer’s Slack scopes', 'done'),
        worker('flake', 'Fix flaky relay reconnect test', 'failed')
      ],
      finishedTotal: 9,
      failedTotal: 1
    })
  ],
  workspaceChats: {}
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
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-bot-sheet-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir: built.outDir, cspHeader })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
}, 240_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function openBotHome(capabilities, overrides = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'render-check-session',
    buildId: 'render-check-build',
    route: { pathname: BOT_HOME_ROUTE },
    host: SHELL_HOST,
    storage: {},
    colorScheme: 'light',
    faultGrant,
    grants: [faultGrant, ...sessionGrants()],
    pageRoutes: ['/h/[hostId]', SESSION_PATTERN],
    replies: { ...replies(capabilities), ...overrides }
  })
  const errors = []
  page.on('pageerror', (error) => errors.push(`${error.name}: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`)
    }
  })
  await page.goto(`${origin}/`, { waitUntil: 'load' })
  await page.waitForFunction(() => document.documentElement.dataset.orcaWebEntry === 'mounted', {
    timeout: 60_000,
    polling: 250
  })
  await page.waitForFunction(() => document.body.innerText.includes('Esc'), {
    timeout: 60_000,
    polling: 250
  })
  return { page, errors }
}

const bodyText = (page) => page.evaluate(() => document.body.innerText)
const waitForText = (page, needle) =>
  page.waitForFunction((text) => document.body.innerText.includes(text), needle, {
    timeout: 30_000,
    polling: 250
  })

describeRender('a bot’s home chat in a real browser', () => {
  it('draws the bot’s header and its sheet, and saves a setting through the phone route', async () => {
    const { page, errors } = await openBotHome(['bots.mobile.v1'], { 'bots.chatTree': CHAT_TREE })
    // A working worker makes the header say so.
    await waitForText(page, 'Working')
    expect(await bodyText(page)).toContain('Atlas')

    await openMobileBotSheet(page, BOT.name)
    await waitForText(page, 'Home Chat')
    await captureBotView(page, 'mobile-activity-light')

    await page.click('[data-testid="bot-sheet-tab-automations"]')
    await waitForText(page, 'Hourly at :05')
    let text = await bodyText(page)
    expect(text).toContain('Morning digest')
    expect(text).toContain('Run now')
    expect(text).toContain('Won’t run: needs the Slack connector')
    await page.waitForSelector('[aria-label="Pause Morning digest"]')
    await captureBotView(page, 'mobile-automations-light')

    await page.click('[data-testid="bot-sheet-tab-settings"]')
    await waitForText(page, 'Needs permission')
    text = await bodyText(page)
    for (const line of ['Active', 'Task complete', 'Same as chats', 'Dana Kim', 'Slack']) {
      expect(text).toContain(line)
    }
    await expect
      .poll(() =>
        page
          .getByRole('switch', { name: 'Active', exact: true })
          .evaluate((node) => getComputedStyle(node.firstElementChild).backgroundColor)
      )
      .toBe('rgb(10, 10, 10)')
    await captureBotView(page, 'mobile-settings-light')
    await page.evaluate(() => globalThis.__orcaRenderCheckResendInit({ colorScheme: 'dark' }))
    await expect
      .poll(() =>
        page
          .getByRole('switch', { name: 'Active', exact: true })
          .evaluate((node) => getComputedStyle(node.firstElementChild).backgroundColor)
      )
      .toBe('rgb(250, 250, 250)')
    await captureBotView(page, 'mobile-settings-dark')
    await page.click('[aria-label="Task complete"]')
    const requests = await waitForRecordedRequests(page, ['bots.update'])
    expect(
      requests.find(
        (request) => request.method === 'bots.update' && request.params.updates.notifications
      ).params
    ).toEqual({
      botId: 'bot-1',
      updates: {
        notifications: { needsPermission: true, taskComplete: false, couldNotFinish: true }
      }
    })
    await page.getByRole('button', { name: 'Permissions, Same as chats', exact: true }).click()
    expect(await page.getByRole('radio', { name: 'Accept edits', exact: true }).count()).toBe(0)
    await page.getByRole('radio', { name: 'Ask for approval', exact: true }).click()
    const permissionWrites = await page.evaluate(() =>
      globalThis.__orcaRenderCheckRequests.filter(
        (request) => request.method === 'bots.update' && request.params?.updates.permissionMode
      )
    )
    expect(permissionWrites.at(-1).params.updates.permissionMode).toBe('ask')
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)

  it('draws the bot’s chats with their workers nested, folds a chat and pages its finished workers', async () => {
    const { page, errors } = await openBotHome(['bots.mobile.v1'], { 'bots.chatTree': CHAT_TREE })
    await openMobileBotSheet(page, BOT.name)
    await waitForText(page, 'Home Chat')
    let text = await bodyText(page)
    // Home pinned, then the chat waiting on the owner, then the one replying, then the rest.
    const order = [
      'Home Chat',
      'Why ux-designer',
      'Draft the 1.4.230',
      'Tidy the release checklist'
    ].map((title) => text.indexOf(title))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order[0]).toBeGreaterThan(-1)
    // Every chat starts folded: a live one shows its counts, a finished one only its time.
    expect(text).toContain('1 waiting · 1 running')
    expect(text).not.toContain('Paired bots PR 6')
    expect(text).not.toContain('checklist-cleanup')

    await page.getByRole('button', { name: 'Unfold Home Chat', exact: true }).click()
    await waitForText(page, 'Paired bots PR 6: relay auth')
    text = await bodyText(page)
    // Its workers open waiting first, then the rest, paged.
    expect(text.indexOf('Paired bots PR 6')).toBeLessThan(text.indexOf('Phone: one Bots list'))
    expect(text).toContain('Needs you')
    expect(text).toContain('Show 7 earlier')
    expect(text).not.toContain('1 waiting · 1 running')
    await captureBotView(page, 'mobile-chats-tree-light')

    await page
      .getByRole('button', { name: 'Unfold Tidy the release checklist', exact: true })
      .click()
    await waitForText(page, 'checklist-cleanup')
    await page.getByRole('button', { name: 'Fold Home Chat', exact: true }).click()
    text = await bodyText(page)
    expect(text).not.toContain('Paired bots PR 6')
    expect(text).toContain('1 waiting · 1 running')
    await captureBotView(page, 'mobile-chats-tree-folded')
    await page.getByRole('button', { name: 'Unfold Home Chat', exact: true }).click()

    await page.getByRole('button', { name: 'Show 7 earlier', exact: true }).click()
    // The next page starts past the last finished worker shown.
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            globalThis.__orcaRenderCheckRequests.find(
              (request) => request.method === 'bots.chatTree' && request.params.chatId === 'chat-1'
            )?.params.finishedAfter?.key
        )
      )
      .toBe('flake')
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)

  it('shows a failed Activity read and retries through the existing refresh path', async () => {
    const { page, errors } = await openBotHome(['bots.mobile.v1'], { 'bots.activity': null })
    await openMobileBotSheet(page, BOT.name)
    await waitForText(page, 'Couldn’t load activity')
    await captureBotView(page, 'mobile-activity-retry')
    const before = await page.evaluate(
      () =>
        globalThis.__orcaRenderCheckRequests.filter((request) => request.method === 'bots.activity')
          .length
    )
    await page.getByRole('button', { name: 'Retry', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            globalThis.__orcaRenderCheckRequests.filter(
              (request) => request.method === 'bots.activity'
            ).length
        )
      )
      .toBeGreaterThan(before)
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('asks for no bot and draws no sheet button on a host without the capability', async () => {
    const { page, errors } = await openBotHome([])
    const requests = await waitForRecordedRequests(page, ['session.tabs.list'])
    await page.waitForTimeout(500)
    expect(requests.map((request) => request.method)).not.toContain('bots.list')
    await page.getByRole('button', { name: 'More session actions', exact: true }).click()
    expect(await page.getByRole('menuitem', { name: BOT.name, exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)
})
