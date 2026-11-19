import { openMobileBotSheet } from './preview/mobile-bot-sheet-controls.mjs'
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

// Real browser proves the bot sheet lists who is asking for access, confirms before a grant, and answers through bots.access.decide.

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

const REQUEST = (requestId, id, name, handle) => ({
  requestId,
  botId: 'bot-1',
  source: 'slack',
  workspaceId: 'T1',
  workspaceName: 'Acme',
  requester: { id, name, handle, detail: name },
  createdAt: 1,
  expiresAt: 2
})

function replies(capabilities) {
  return {
    'bots.access.list': {
      ok: true,
      value: [REQUEST('req-1', 'U2', 'Lee Park', 'lee'), REQUEST('req-2', 'U3', 'Sam Ortiz', 'sam')]
    },
    'bots.access.decide': { ok: true },
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
        automations: [],
        waits: []
      }
    },
    'automation.list': {
      automations: [
        automation({}),
        automation({ id: 'auto-2', name: 'Someone else', workspaceId: 'folder:elsewhere' })
      ]
    },
    'automation.runs': { runs: [] },
    'bots.updateFromPhone': {
      bot: { ...BOT, notifications: { ...BOT.notifications, taskComplete: false } }
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
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-bot-access-'))
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

async function openBotHome(capabilities) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'render-check-session',
    buildId: 'render-check-build',
    route: { pathname: BOT_HOME_ROUTE },
    host: SHELL_HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant, ...sessionGrants()],
    pageRoutes: ['/h/[hostId]', SESSION_PATTERN],
    replies: replies(capabilities)
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

async function openSettings(capabilities) {
  const opened = await openBotHome(capabilities)
  await openMobileBotSheet(opened.page, BOT.name)
  await opened.page.click('[data-testid="bot-sheet-tab-settings"]')
  await waitForText(opened.page, 'Needs permission')
  return opened
}

const decisions = (requests) =>
  requests.filter((request) => request.method === 'bots.access.decide').map((r) => r.params)

describeRender('a bot’s access requests in its sheet, in a real browser', () => {
  it('lists who is asking, confirms before a grant, and answers through the host', async () => {
    const { page, errors } = await openSettings(['bots.mobile.v1'])
    await waitForText(page, 'Lee Park')
    const text = await bodyText(page)
    expect(text).toContain('Asking for access')
    expect(text).toContain('@lee · Slack (Acme)')

    await page.click('[aria-label="Review Lee Park"]')
    await waitForText(page, 'Give Lee Park access to Atlas?')
    expect(decisions(await page.evaluate(() => globalThis.__orcaRenderCheckRequests))).toEqual([])
    await page.click('text=Give access')
    let requests = await waitForRecordedRequests(page, ['bots.access.decide'])
    expect(decisions(requests)).toEqual([{ requestId: 'req-1', decision: 'granted' }])

    await page.waitForFunction(() => !document.body.innerText.includes('Lee Park'), null, {
      timeout: 30_000
    })
    await page.click('[aria-label="Decline Sam Ortiz"]')
    await page.waitForFunction(() => !document.body.innerText.includes('Sam Ortiz'), null, {
      timeout: 30_000
    })
    requests = await page.evaluate(() => globalThis.__orcaRenderCheckRequests)
    expect(decisions(requests)).toEqual([
      { requestId: 'req-1', decision: 'granted' },
      { requestId: 'req-2', decision: 'declined' }
    ])
    expect(await bodyText(page)).not.toContain('Asking for access')
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)
})
