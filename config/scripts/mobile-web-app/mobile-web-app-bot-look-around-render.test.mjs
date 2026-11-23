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

// Real browser proves the bot sheet draws Suggestions and Look around, Start fills the Home Chat's
// message box, and a Settings change sends only the field it changed.

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
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'atlas-home',
  agent: 'claude',
  avatar: 'mascot:A1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  lookAround: { on: true, every: 'every-4h', weekdaysOnly: true, focus: 'PRs waiting on me' },
  chatSessionId: 'chat-1',
  createdAt: 1,
  updatedAt: 1
}

const TIDY_UP = {
  setting: { on: true, every: 'night' },
  last: {
    at: Date.now(),
    tookMs: 2 * 60_000,
    chats: 4,
    rowId: 'row-7',
    learned: ['Releases go out on Tuesdays'],
    replaced: ['Staging deploys go out on Fridays'],
    filed: [{ topic: 'release', count: 4 }],
    moved: 9,
    merged: 2,
    undone: false
  },
  running: false,
  turnedOff: null,
  error: null
}

function suggestion(id, title, extra) {
  return { id, title, why: `Why ${title}`, ask: `Please ${title}`, createdAt: 1, ...extra }
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
        workers: [],
        inProgress: [],
        completed: [],
        automations: [],
        waits: [],
        upNext: {
          state: { running: false, lastLookedAt: Date.now(), seenAt: 1 },
          items: [
            suggestion('s1', 'Answer review comments on PR #1234', {
              link: 'https://github.com/stablyai/orca/pull/1234',
              source: 'github'
            }),
            suggestion('s2', 'Fix the failing typecheck on main'),
            suggestion('s3', 'Answer Priya in #eng', {
              link: 'https://acme.slack.com/archives/C1/p1',
              source: 'slack'
            }),
            suggestion('s4', 'Close the stale release issue')
          ]
        }
      }
    },
    // A Slack thread's chat is showing, so Start has to switch to the Home Chat.
    'session.tabs.list': {
      worktree: 'folder:atlas-home',
      publicationEpoch: 'e1',
      snapshotVersion: 1,
      activeGroupId: 'g1',
      activeTabId: 'agent-session:thread-1',
      activeTabType: 'agent-session',
      tabGroups: [
        {
          id: 'g1',
          activeTabId: 'agent-session:thread-1',
          tabOrder: ['agent-session:chat-1', 'agent-session:thread-1']
        }
      ],
      tabs: [
        {
          id: 'agent-session:chat-1',
          type: 'agent-session',
          title: 'Scout',
          sessionId: 'chat-1',
          agent: 'claude',
          isActive: false
        },
        {
          id: 'agent-session:thread-1',
          type: 'agent-session',
          title: 'Slack thread',
          sessionId: 'thread-1',
          agent: 'claude',
          isActive: true
        }
      ]
    },
    'bots.suggestions.start': { ask: 'Please answer the review comments on PR #1234' },
    'bots.tidyUp.get': { tidyUp: TIDY_UP },
    'bots.tidyUp.undo': {
      undone: true,
      tidyUp: { ...TIDY_UP, last: { ...TIDY_UP.last, undone: true } }
    },
    'bots.update': {
      bot: { ...BOT, lookAround: { ...BOT.lookAround, weekdaysOnly: false } }
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
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-web-app-bot-look-around-'))
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

async function openBotHome(capabilities, colorScheme = 'light') {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  await page.addInitScript(installShellDouble, {
    version: bridgeVersion,
    sessionId: 'render-check-session',
    buildId: 'render-check-build',
    route: { pathname: BOT_HOME_ROUTE },
    host: SHELL_HOST,
    storage: {},
    colorScheme,
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
  return { page, errors }
}

const bodyText = (page) => page.evaluate(() => document.body.innerText)
const waitForText = (page, needle) =>
  page.waitForFunction((text) => document.body.innerText.includes(text), needle, {
    timeout: 30_000,
    polling: 250
  })

describeRender('Look around in the phone’s bot sheet', () => {
  it('lists Suggestions, and Start puts the request in the Home Chat, not the chat showing', async () => {
    const { page, errors } = await openBotHome(['bots.mobile.v1'])
    await openMobileBotSheet(page, BOT.name)
    await waitForText(page, 'Answer review comments on PR #1234')
    const text = await bodyText(page)
    expect(text).toContain('Suggestions')
    expect(text).toContain('Looked ')
    expect(text).toContain('orca#1234')
    expect(text).toContain('Show 1 more')
    expect(text).not.toContain('Close the stale release issue')

    await page.getByText('Show 1 more', { exact: true }).click()
    await page.getByText('Close the stale release issue', { exact: true }).waitFor()

    await page.getByText('Start', { exact: true }).first().click()
    const requests = await waitForRecordedRequests(page, ['bots.suggestions.start'])
    expect(requests.find((request) => request.method === 'bots.suggestions.start').params).toEqual({
      botId: 'bot-1',
      suggestionId: 's1'
    })
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('textarea')].some((field) =>
          field.value.includes('Please answer the review comments on PR #1234')
        ),
      null,
      { timeout: 30_000, polling: 250 }
    )
    const activated = await waitForRecordedRequests(page, ['session.tabs.activate'])
    expect(
      activated.find((request) => request.method === 'session.tabs.activate').params
    ).toMatchObject({ tabId: 'agent-session:chat-1' })
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)

  it('shows Look around in Settings and saves only the changed field', async () => {
    const { page, errors } = await openBotHome(['bots.mobile.v1'])
    await openMobileBotSheet(page, BOT.name)
    await page.click('[data-testid="bot-sheet-tab-settings"]')
    await waitForText(page, 'Suggest next steps')
    const text = await bodyText(page)
    for (const line of [
      'How often',
      'Every 4 hours, 8 AM to 8 PM',
      'Look for',
      'PRs waiting on me'
    ]) {
      expect(text).toContain(line)
    }
    await captureBotView(page, 'mobile-look-around-light')
    await page.click('[aria-label="Weekdays only"]')
    const requests = await waitForRecordedRequests(page, ['bots.update'])
    expect(requests.find((request) => request.method === 'bots.update').params).toEqual({
      botId: 'bot-1',
      updates: { lookAround: { weekdaysOnly: false } }
    })
    await page.getByRole('button', { name: /^How often, Every 4 hours/ }).click()
    await page.getByRole('radio', { name: 'Every 2 hours, 8 AM to 8 PM', exact: true }).click()
    await expect
      .poll(() =>
        page.evaluate(() =>
          globalThis.__orcaRenderCheckRequests.some(
            (request) =>
              request.method === 'bots.update' &&
              request.params?.updates.lookAround?.every === 'every-2h'
          )
        )
      )
      .toBe(true)
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)

  it('shows Memory upkeep, the last tidy-up, and undoes the one it shows', async () => {
    const { page, errors } = await openBotHome(['bots.mobile.v1'], 'dark')
    await openMobileBotSheet(page, BOT.name)
    await page.click('[data-testid="bot-sheet-tab-settings"]')
    await waitForText(page, 'Tidy memory overnight')
    const text = await bodyText(page)
    for (const line of ['Memory upkeep', 'Each night', 'Last tidied', 'Tidy now']) {
      expect(text).toContain(line)
    }
    await page.getByText('Tidy now', { exact: true }).scrollIntoViewIfNeeded()
    await captureBotView(page, 'mobile-tidy-up-settings-dark')
    await page.getByText('Last tidied').click()
    await waitForText(page, 'Learned from chats')
    expect(await bodyText(page)).toContain('Marked replaced: Staging deploys go out on Fridays')
    await captureBotView(page, 'mobile-tidy-up-summary-dark')
    await page.getByText('Undo', { exact: true }).click()
    const requests = await waitForRecordedRequests(page, ['bots.tidyUp.undo'])
    expect(requests.find((request) => request.method === 'bots.tidyUp.undo').params).toEqual({
      botId: 'bot-1',
      rowId: 'row-7'
    })
    expect(errors).toEqual([])
    await page.close()
  }, 120_000)
})
