import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium } from 'playwright-core'
import { buildMobileWebAppBundle } from '../build-mobile-web-app-bundle.mjs'
import { mobileWebAppDependenciesPresent } from './mobile-web-app-bundle-dependencies.mjs'
import {
  createBundleServer,
  installShellDouble,
  readBridgeFaultGrant,
  readBridgeProtocolVersion,
  readShellCsp
} from './preview/mobile-web-app-render-harness.mjs'

const HOST = {
  id: 'conversation-host',
  name: 'MacBook',
  endpoint: 'ws://fixture',
  lastConnected: 1
}
const ROUTE = `/h/${HOST.id}`
const WORKSPACE = 'atlas::/projects/atlas'
const agent = (paneKey, taskTitle) => ({
  paneKey,
  parentPaneKey: null,
  state: 'done',
  agentType: 'codex',
  prompt: taskTitle,
  taskTitle,
  displayName: null,
  lastAssistantMessage: 'Done',
  toolName: null,
  toolInput: null,
  interrupted: false,
  stateStartedAt: 1792800000000,
  updatedAt: 1792800000000
})
const workspace = (worktreeId, repoId, repo, path, branch, extra = {}) => ({
  worktreeId,
  repoId,
  repo,
  path,
  branch,
  displayName: branch || repo,
  hostId: 'local',
  liveTerminalCount: 1,
  hasAttachedPty: true,
  unread: false,
  isPinned: false,
  isMainWorktree: true,
  linkedPR: { number: 42, state: 'open' },
  agents: [],
  ...extra
})
const WORKSPACES = [
  workspace(WORKSPACE, 'atlas', 'Atlas', '/projects/atlas', 'master', {
    agents: [agent('terminal:navigation', 'Clearer conversation navigation')]
  }),
  workspace(
    'atlas::/projects/atlas-fix',
    'atlas',
    'Atlas',
    '/projects/atlas-fix',
    'feat/private-branch',
    {
      isMainWorktree: false,
      linkedPR: { number: 57, state: 'merged' },
      agents: [agent('terminal:composer', 'Polish the message composer')]
    }
  ),
  workspace('folder:notes', 'notes', 'Notes', '/documents/notes', '', {
    workspaceKind: 'folder-workspace',
    agents: [agent('terminal:notes', 'Organize the release notes')]
  })
]
const saved = (id, title, extra = {}) => ({
  id,
  executionHostId: 'local',
  agent: 'claude',
  sessionId: id,
  title,
  cwd: '/projects/atlas',
  branch: 'master',
  model: 'recorded-model',
  filePath: `/transcripts/${id}.jsonl`,
  codexHome: null,
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-24T12:00:00Z',
  messageCount: 2,
  totalTokens: 10,
  previewMessages: [{ role: 'user', text: 'Review the plan', timestamp: null }],
  ...extra
})
const REPLIES = {
  'status.get': {
    protocolVersion: 5,
    minCompatibleMobileVersion: 1,
    appVersion: '1.4.200',
    platform: 'darwin',
    capabilities: [
      'aiVault.v1',
      'agent.launch.v2',
      'agent.launch.replay-required.v1',
      'agent-session.structured.reveal.v1'
    ],
    floatingWorkspaceEnabled: false
  },
  'worktree.ps': { worktrees: WORKSPACES },
  'repo.list': {
    repos: [{ id: 'atlas', displayName: 'Atlas', path: '/projects/atlas', connectionId: null }]
  },
  'settings.get': { settings: { defaultTuiAgent: 'codex' } },
  'session.tabs.list': { tabs: [], snapshotVersion: 1, activeTabId: null, activeTabType: null },
  'aiVault.listSessions': {
    sessions: [
      saved('transcript', 'Review the onboarding plan'),
      saved('empty', 'A saved empty conversation', {
        source: 'structured-record',
        filePath: '',
        messageCount: 0,
        previewMessages: [],
        structuredSession: { sessionId: 'saved-empty', workspaceId: WORKSPACE }
      })
    ],
    issues: [],
    includesStructuredSessions: true
  },
  'preflight.detectAgents': ['codex', 'claude'],
  'agent.launchReplay': {
    worktreeId: WORKSPACE,
    outcome: { kind: 'terminal', handle: 'terminal:new-chat' },
    receipt: {
      mode: 'terminal',
      preferred: 'terminal',
      reason: 'user_default',
      detail: 'Started a terminal agent.'
    }
  },
  'agentSession.reveal': { ok: true, sessionId: 'saved-empty', workspaceId: WORKSPACE },
  'worktree.activate': {}
}

const describeRender = mobileWebAppDependenciesPresent() ? describe : describe.skip
let scratch, server, browser, origin, version, faultGrant
const proofDir = process.env.ORCA_CONVERSATION_PROOF_DIR

beforeAll(async () => {
  version = await readBridgeProtocolVersion()
  faultGrant = await readBridgeFaultGrant()
  scratch = await mkdtemp(join(tmpdir(), 'orca-mobile-conversations-'))
  const built = await buildMobileWebAppBundle({ outDir: join(scratch, 'bundle') })
  const served = await createBundleServer({ outDir: built.outDir, cspHeader: await readShellCsp() })
  server = served.server
  origin = served.origin
  const executablePath = process.env.ORCA_MOBILE_WEB_RENDER_BROWSER
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) })
  if (proofDir) {
    await mkdir(proofDir, { recursive: true })
  }
}, 180_000)

afterAll(async () => {
  await browser?.close()
  server?.close()
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
  }
})

async function open(replies = REPLIES) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(installShellDouble, {
    version,
    sessionId: 'conversation-render',
    buildId: 'conversation-build',
    route: { pathname: ROUTE },
    host: HOST,
    storage: {},
    faultGrant,
    grants: [faultGrant, 'navigate'],
    pageRoutes: ['/h/[hostId]'],
    replies
  })
  await page.goto(origin)
  await page.getByRole('button', { name: 'Clearer conversation navigation', exact: true }).waitFor()
  await page.getByRole('button', { name: 'A saved empty conversation', exact: true }).waitFor()
  return { page, errors }
}

async function proof(page, name) {
  if (!proofDir) {
    return
  }
  const cdp = await page.context().newCDPSession(page)
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: false
  })
  await writeFile(join(proofDir, `${name}.png`), Buffer.from(shot.data, 'base64'))
  await cdp.detach()
}

const requests = (page) => page.evaluate(() => globalThis.__orcaRenderCheckRequests)
const notifies = (page) =>
  page.evaluate(() =>
    globalThis.__orcaRenderCheckNotifies.filter((frame) => frame.name === 'navigate')
  )

describeRender('the actual mobile project conversation list', () => {
  it('opens a selected transcript with its preview expanded and no workspace badge', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(installShellDouble, {
      version,
      sessionId: 'selected-history',
      buildId: 'conversation-build',
      route: {
        pathname: `${ROUTE}/agent-history/${encodeURIComponent(WORKSPACE)}`,
        params: { name: 'Review the onboarding plan', conversationId: 'transcript' }
      },
      host: HOST,
      storage: {},
      faultGrant,
      grants: [faultGrant, 'navigate'],
      pageRoutes: ['/h/[hostId]/agent-history/[worktreeId]'],
      replies: REPLIES
    })
    await page.goto(origin)
    await page.getByText('Review the plan', { exact: true }).last().waitFor()
    const text = await page.locator('body').innerText()
    expect(text).toContain('История разговоров')
    expect(text).not.toMatch(
      /A saved empty conversation|current worktree|master|PR #|PROJECTS\/ATLAS/
    )
    await proof(page, 'selected-transcript')
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('groups chats directly under projects and reserves all git metadata for details', async () => {
    const { page, errors } = await open()
    const text = await page.locator('body').innerText()
    expect(text).toContain('Проекты')
    expect(text).toContain('Atlas')
    expect(text).toContain('Notes')
    expect(await page.getByTestId('conversation-row').count()).toBe(5)
    expect(text).not.toMatch(/master|feat\/private-branch|PR #|\/projects\/|recorded-model/)
    await proof(page, 'after-conversations')
    await page
      .getByRole('button', {
        name: 'Детали разговора: Clearer conversation navigation',
        exact: true
      })
      .click()
    await page.getByText('Ветка: master', { exact: false }).waitFor()
    expect(await page.locator('body').innerText()).toContain('PR #42')
    await proof(page, 'conversation-details')
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('opens the selected pane and targets new chat creation at the project main workspace', async () => {
    const { page, errors } = await open()
    await page.getByRole('button', { name: 'Clearer conversation navigation', exact: true }).click()
    await expect
      .poll(() => notifies(page))
      .toEqual([
        expect.objectContaining({ href: expect.stringContaining('paneKey=terminal%3Anavigation') })
      ])
    await page.getByRole('button', { name: 'Новый чат: Atlas', exact: true }).click()
    await page.getByText('Выберите агента', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Codex', exact: true }).click()
    await expect
      .poll(async () =>
        (await requests(page)).filter((request) => request.method === 'agent.launchReplay')
      )
      .toEqual([
        expect.objectContaining({
          params: expect.objectContaining({
            agent: 'codex',
            target: { kind: 'existing', worktree: `id:${WORKSPACE}` }
          })
        })
      ])
    await expect
      .poll(() => notifies(page))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ href: expect.stringContaining('paneKey=terminal%3Anew-chat') })
        ])
      )
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('reopens a durable empty conversation and routes a transcript to its specific history entry', async () => {
    const { page, errors } = await open()
    await page.getByRole('button', { name: 'A saved empty conversation', exact: true }).click()
    await expect
      .poll(async () =>
        (await requests(page)).filter((request) => request.method === 'agentSession.reveal')
      )
      .toEqual([{ method: 'agentSession.reveal', params: { sessionId: 'saved-empty' } }])
    await expect
      .poll(() => notifies(page))
      .toEqual([
        expect.objectContaining({
          href: expect.stringContaining('paneKey=structured-agent-session-saved-empty')
        })
      ])
    await page.getByRole('button', { name: 'Review the onboarding plan', exact: true }).click()
    await expect
      .poll(() => notifies(page))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ href: expect.stringContaining('conversationId=transcript') })
        ])
      )
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)

  it('keeps old-host history honest and moves workspace navigation behind advanced settings', async () => {
    const { page, errors } = await open({
      ...REPLIES,
      'aiVault.listSessions': {
        ...REPLIES['aiVault.listSessions'],
        includesStructuredSessions: undefined
      }
    })
    await page.getByText('Этот хост показывает открытые чаты', { exact: false }).waitFor()
    await page.getByRole('button', { name: 'Другие действия', exact: true }).click()
    await page.getByText('Дополнительно: рабочие каталоги', { exact: true }).click()
    await page.getByText('К проектам', { exact: true }).waitFor()
    await page.getByText('master', { exact: true }).first().waitFor()
    await proof(page, 'before-workspaces-preserved')
    await page.getByRole('button', { name: 'К проектам', exact: true }).click()
    await page
      .getByRole('button', { name: 'Clearer conversation navigation', exact: true })
      .waitFor()
    expect(errors).toEqual([])
    await page.close()
  }, 60_000)
})
