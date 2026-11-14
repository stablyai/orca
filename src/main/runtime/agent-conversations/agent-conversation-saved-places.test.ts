import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { normalizeHookPayload } from '../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { makePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { InProcessAgentIdentityClient } from '../../agent-hooks/identity/agent-identity-client.test-fixtures'
import type { AgentIdentityClient } from '../../agent-hooks/identity/agent-identity-worker-client'
import { buildBody } from '../../agent-hooks/server/testing/server.test-fixtures'
import type * as HookServerModule from '../../agent-hooks/server/agent-hook-server'
import type * as TranscriptReadModule from '../orchestration/workers/transcripts/worker-transcript-read'
import { Store } from '../../persistence/loading-store/store'
import { ProfileStateSqliteAuthority } from '../../persistence/profile-state/profile-state-sqlite-authority'
import { OrcaRuntimeService } from '../orca-runtime'
import { isOrcaSessionId, type OrcaSessionId } from '../../../shared/orca-session-address'
import type { RpcContext } from '../rpc/core'
import {
  applyWorktreeSleepResumeRecords,
  captureWorktreeSleepResumeRecords
} from '../terminal/stop/worktree-sleep-resume-records'
import {
  claimSleepRecordForPane,
  markResumedRecordLive
} from '../session-lifecycle/projection/sleep-record-pane-claim'
import { resumeStatusFromHookRow } from '../terminal/stop/hook-status-resume-records'
import {
  liveResumeRecord,
  statusRetainsResumableIdentity
} from '../../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import { windowSaveKeepingMainSleepRecords } from '../../persistence/window-save-sleep-records'

/** The real hook server behind `agent list/show/read`. */
const hooks = vi.hoisted(() => {
  const state: { server: null | Record<string, (...args: never[]) => unknown> } = { server: null }
  return state
})
vi.mock('../../agent-hooks/server/agent-hook-server', async (load) => ({
  ...(await load<typeof HookServerModule>()),
  agentHookServer: new Proxy(
    {},
    {
      get:
        (_, name: string) =>
        (...args: never[]) =>
          hooks.server?.[name]?.(...args)
    }
  )
}))

/** The real transcript reader, counted; a guest path this host can't open is answered here. */
const transcripts = vi.hoisted(() => {
  const state: { reads: number; guestReads: { wslDistro: string; transcriptPath?: string }[] } = {
    reads: 0,
    guestReads: []
  }
  return state
})
vi.mock('../orchestration/workers/transcripts/worker-transcript-read', async (load) => {
  const actual = await load<typeof TranscriptReadModule>()
  return {
    ...actual,
    readWorkerTranscript: async (...args: Parameters<typeof actual.readWorkerTranscript>) => {
      transcripts.reads++
      const [request] = args
      if (!request.wslDistro) {
        return actual.readWorkerTranscript(...args)
      }
      transcripts.guestReads.push({
        wslDistro: request.wslDistro,
        transcriptPath: request.transcriptPath
      })
      return {
        ok: true,
        messages: [
          { id: 'm1', role: 'assistant', blocks: [{ type: 'text', text: request.wslDistro }] }
        ],
        limited: false
      }
    }
  }
})

const { AgentHookServer } = await import('../../agent-hooks/server/agent-hook-server')
const { listAgentConversations, showAgentConversation } = await import('./agent-conversation-list')
const { readAgentConversation } = await import('./agent-conversation-read')

const REPO_ID = 'repo-saved-places'
const cleanups: (() => void)[] = []
afterEach(() => {
  hooks.server = null
  transcripts.reads = 0
  transcripts.guestReads.length = 0
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

class IdentityTestServer extends AgentHookServer {
  readonly identityClient = new InProcessAgentIdentityClient()

  protected override createAgentIdentityClient(): AgentIdentityClient {
    return this.identityClient
  }
}

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'agent-saved-places-'))
  cleanups.push(() => rmSync(path, { recursive: true, force: true }))
  return path
}

const LEAF = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222'
}
const PANE = { a: makePaneKey('tab-a', LEAF.a), b: makePaneKey('tab-b', LEAF.b) }
const SIBLING_LEAF = '33333333-3333-4333-8333-333333333333'
const CAPTURED_AT = 1_800_000_000_000

/** A folder workspace with two terminal tabs, as the app saves it. */
function workspaceSession(worktreeId: string): WorkspaceSessionState {
  const tab = (id: string, title: string, sortOrder: number) => ({
    id,
    ptyId: null,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder,
    createdAt: sortOrder
  })
  const layout = (leafId: string) => ({
    root: { type: 'leaf' as const, leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: {}
  })
  return {
    ...getDefaultWorkspaceSession(),
    activeWorktreeId: worktreeId,
    tabsByWorktree: {
      [worktreeId]: [
        tab('tab-a', 'MANGO single-word reply', 0),
        tab('tab-b', 'Reply with ORBIT', 1)
      ]
    },
    terminalLayoutsByTabId: { 'tab-a': layout(LEAF.a), 'tab-b': layout(LEAF.b) }
  }
}

/** The app's profile store, reopened from disk as a restart reads it. */
function openStore(root: string): Store {
  const store = new Store({
    dataFile: join(root, 'orca-data.json'),
    profileStateAuthority: new ProfileStateSqliteAuthority(join(root, 'profile-state.db'), 'saved')
  })
  cleanups.unshift(() => store.freezeWrites())
  return store
}

async function startedServer(root: string): Promise<IdentityTestServer> {
  const server = new IdentityTestServer()
  cleanups.unshift(() => server.stop())
  await server.start({ env: 'production', userDataPath: root })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the proxy forwards only the hook server's own methods.
  hooks.server = server as unknown as Record<string, (...args: never[]) => unknown>
  return server
}

/** A Claude turn that ends with `reply`, reported by Claude's own hooks on `paneKey`. */
function claudeTurn(server: IdentityTestServer, paneKey: string, tabId: string, reply: string) {
  const state = createHookListenerState()
  const transcriptPath = join(directory(), 'claude-session.jsonl')
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: 'assistant',
      uuid: 'u1',
      sessionId: 'claude-session',
      timestamp: '2026-11-13T12:00:00.000Z',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: reply }] }
    })}\n`
  )
  for (const body of [
    { hook_event_name: 'UserPromptSubmit', prompt: `Reply with ${reply}` },
    { hook_event_name: 'Stop', last_assistant_message: reply }
  ]) {
    const event = normalizeHookPayload(
      state,
      'claude',
      buildBody(
        { ...body, session_id: 'claude-session', transcript_path: transcriptPath },
        { paneKey, tabId }
      ),
      'production'
    )
    server.ingestRemote(event!, null)
  }
}

/** A Codex turn that ends with `reply`, as its hook relay reports it. */
function codexTurn(
  server: IdentityTestServer,
  paneKey: string,
  reply: string | undefined,
  state: 'done' | 'waiting' = 'done'
) {
  const event: AgentHookEventPayload = {
    paneKey,
    connectionId: null,
    source: 'codex',
    hookEventName: reply ? 'Stop' : 'SessionStart',
    providerSession: { key: 'session_id', id: 'codex-thread' },
    payload: {
      agentType: 'codex',
      state,
      prompt: reply ? `Reply with ${reply}` : '',
      ...(reply ? { lastAssistantMessage: reply } : {})
    }
  }
  server.ingestRemote(event, null)
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

function orcaId(id: string | null | undefined): OrcaSessionId {
  if (!id || !isOrcaSessionId(id)) {
    throw new Error('the agent was not named')
  }
  return id
}

/** Opens the saved workspace on `root` with the app's real store, runtime and hook server. */
async function openApp(root: string, worktreeId: string, seed?: () => WorkspaceSessionState) {
  const server = await startedServer(root)
  const store = openStore(root)
  if (seed) {
    store.addRepo({
      id: REPO_ID,
      path: worktreeId.slice(`${REPO_ID}::`.length),
      displayName: 'gitrepo',
      badgeColor: 'gray',
      addedAt: 1,
      kind: 'folder'
    })
    store.setWorkspaceSession(seed())
    store.flushOrThrow()
  }
  const runtime = new OrcaRuntimeService(store, undefined, {
    getAgentStatusSnapshot: () => server.getStatusSnapshot()
  })
  const commit = async (
    edit: (session: WorkspaceSessionState) => WorkspaceSessionState | null
  ): Promise<void> => {
    const next = edit(structuredClone(store.getWorkspaceSession()))
    if (next) {
      store.setWorkspaceSession(next)
    }
  }
  const row = (paneKey: string) =>
    server.getStatusSnapshot().find((candidate) => candidate.paneKey === paneKey)
  const list = async () => {
    const agents = (await listAgentConversations(runtime, 100)).agents
    return Object.fromEntries(
      agents.map((agent) => [
        agent.paneKey === PANE.a ? 'a' : 'b',
        {
          id: agent.orcaSessionId,
          state: agent.state,
          title: agent.title,
          reply: agent.lastAssistantMessage
        }
      ])
    )
  }
  /** Quits as the app does: its hook server stops and the profile is written. */
  const quit = async () => {
    await store.flushPendingOrThrowAsync()
    server.stop()
  }
  return { server, store, runtime, commit, row, list, quit }
}

/** Main's own sleep: capture from the hook rows, stop the panes, then save the records. */
async function sleepWorkspace(app: Awaited<ReturnType<typeof openApp>>, worktreeId: string) {
  const capture = await captureWorktreeSleepResumeRecords({
    worktreeId,
    paneKeysByPtyId: new Map([
      ['pty-a', [PANE.a]],
      ['pty-b', [PANE.b]]
    ]),
    launchByPtyId: new Map(),
    readRows: () => app.server.getStatusSnapshot(),
    checkAgentPresence: null,
    capturedAt: CAPTURED_AT
  })
  for (const paneKey of [PANE.a, PANE.b]) {
    app.server.dropStatusEntry(paneKey, { preserveResumeIdentity: true })
  }
  await app.commit((session) =>
    applyWorktreeSleepResumeRecords(session, capture, ['pty-a', 'pty-b'])
  )
  await app.store.flushPendingOrThrowAsync()
}

/** Opening a slept tab: main claims its record, resumes it and marks it live. */
async function wakeTab(app: Awaited<ReturnType<typeof openApp>>, paneKey: string) {
  const record = app.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]
  expect(await claimSleepRecordForPane(app.commit, record!)).toBe(true)
  const claimed = app.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[paneKey]
  await markResumedRecordLive(app.commit, paneKey, claimed!)
}

it('keeps two agents named, titled and with their last reply from sleep through wake and restart', async () => {
  const root = directory()
  const worktreeId = `${REPO_ID}::${directory()}`
  const app = await openApp(root, worktreeId, () => workspaceSession(worktreeId))
  claudeTurn(app.server, PANE.a, 'tab-a', 'MANGO')
  codexTurn(app.server, PANE.b, 'ORBIT')
  await settle()
  const live = await app.list()
  const ids = { a: orcaId(live.a!.id), b: orcaId(live.b!.id) }
  expect(ids.a).toMatch(/^claude_/)
  expect(ids.b).toMatch(/^codex_/)
  const named = {
    a: { id: ids.a, title: 'MANGO single-word reply', reply: 'MANGO' },
    b: { id: ids.b, title: 'Reply with ORBIT', reply: 'ORBIT' }
  }
  expect(live).toMatchObject({ a: { state: 'done', ...named.a }, b: { state: 'done', ...named.b } })

  await sleepWorkspace(app, worktreeId)
  // A restart reads the records back through the saved-state schema.
  await app.quit()
  const reopened = await openApp(root, worktreeId)
  expect(await reopened.list()).toEqual({
    a: { state: 'asleep', ...named.a },
    b: { state: 'asleep', ...named.b }
  })
  expect(
    await showAgentConversation(reopened.runtime, { kind: 'terminal', orcaSessionId: ids.a })
  ).toMatchObject({ places: [{ state: 'asleep', paneKey: PANE.a, lastAssistantMessage: 'MANGO' }] })
  expect(
    await readAgentConversation(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a terminal read uses only the runtime's sleeping records.
      { runtime: reopened.runtime } as unknown as RpcContext,
      { kind: 'terminal', orcaSessionId: ids.a },
      {}
    )
  ).toMatchObject({ entries: [{ role: 'assistant', text: 'MANGO' }] })

  // Waking shows tab b; Codex resumes and reports with no new reply. Main records it live.
  await wakeTab(reopened, PANE.b)
  codexTurn(reopened.server, PANE.b, undefined, 'waiting')
  await settle()
  reopened.runtime.recordHookStatusResume(reopened.row(PANE.b)!)
  await reopened.runtime.readSavedResumeSource(worktreeId, PANE.b)
  expect(await reopened.list()).toEqual({
    a: { state: 'asleep', ...named.a },
    b: { state: 'waiting', ...named.b }
  })

  // Visiting tab a mounts it; the window saves its own live record, which has no reply.
  await wakeTab(reopened, PANE.a)
  claudeResumed(reopened.server, PANE.a, 'tab-a')
  await settle()
  const status = resumeStatusFromHookRow(reopened.row(PANE.a)!, undefined)!
  const windowRecord = liveResumeRecord({
    entry: status,
    retainsResumableIdentity: statusRetainsResumableIdentity(status, status.providerSession),
    worktreeIdOf: () => worktreeId,
    tabOf: () => ({ id: 'tab-a' }),
    capturedAt: CAPTURED_AT
  })!
  expect(windowRecord.lastAssistantMessage).toBeUndefined()
  const stored = reopened.store.getWorkspaceSession()
  reopened.store.setWorkspaceSession(
    windowSaveKeepingMainSleepRecords(
      stored,
      {
        ...stored,
        sleepingAgentSessionsByPaneKey: {
          ...stored.sleepingAgentSessionsByPaneKey,
          [PANE.a]: windowRecord
        }
      },
      'set'
    ),
    undefined
  )
  expect(await reopened.list()).toMatchObject({
    a: { state: 'done', ...named.a },
    b: { state: 'waiting', ...named.b }
  })

  // Quitting and reopening: each keeps its ID, title and reply, restored or asleep.
  await reopened.quit()
  const restarted = await openApp(root, worktreeId)
  expect(await restarted.list()).toMatchObject(named)
})

/** Claude resumed by `--resume` and idle: its hooks report the session done with no new reply. */
function claudeResumed(server: IdentityTestServer, paneKey: string, tabId: string) {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(
      {
        hook_event_name: 'Stop',
        session_id: 'claude-session',
        transcript_path: join(directory(), 'claude-session.jsonl')
      },
      { paneKey, tabId }
    ),
    'production'
  )
  server.ingestRemote(event!, null)
}

it('names an asleep agent from its saved tab as a live row is named, never from another conversation', async () => {
  const root = directory()
  const worktreeId = `${REPO_ID}::${directory()}`
  const app = await openApp(root, worktreeId, () => workspaceSession(worktreeId))
  claudeTurn(app.server, PANE.a, 'tab-a', 'MANGO')
  codexTurn(app.server, PANE.b, 'ORBIT')
  await settle()
  await sleepWorkspace(app, worktreeId)
  const editTabs = async (edit: (session: WorkspaceSessionState) => void) =>
    app.commit((session) => {
      edit(session)
      return session
    })
  const tab = (session: WorkspaceSessionState, id: string) =>
    session.tabsByWorktree[worktreeId]!.find((candidate) => candidate.id === id)!
  const titles = async () => {
    const listed = await app.list()
    return { a: listed.a?.title, b: listed.b?.title }
  }

  // Another conversation's provider title never names this pane; its own does.
  await editTabs((session) => {
    tab(session, 'tab-b').aiVaultTitle = {
      agent: 'codex',
      sessionId: 'another-thread',
      title: 'Another conversation'
    }
  })
  expect((await titles()).b).toBe('Reply with ORBIT')
  await editTabs((session) => {
    tab(session, 'tab-b').aiVaultTitle = {
      agent: 'codex',
      sessionId: 'codex-thread',
      title: 'ORBIT from its session',
      kind: 'named'
    }
  })
  expect((await titles()).b).toBe('ORBIT from its session')

  // A generated title counts only while the setting is on.
  await editTabs((session) => {
    tab(session, 'tab-a').generatedTitle = 'Generated MANGO'
  })
  expect((await titles()).a).toBe('MANGO single-word reply')
  app.store.updateSettings({ tabAutoGenerateTitle: true })
  expect((await titles()).a).toBe('Generated MANGO')
  app.store.updateSettings({ tabAutoGenerateTitle: false })

  // Split: the tab's title is the focused sibling's; the asleep pane takes only its own.
  await editTabs((session) => {
    tab(session, 'tab-a').title = 'Sibling shell'
    session.terminalLayoutsByTabId['tab-a'] = {
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF.a },
        second: { type: 'leaf', leafId: SIBLING_LEAF }
      },
      activeLeafId: SIBLING_LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: {},
      titlesByLeafId: { [SIBLING_LEAF]: 'Sibling shell' }
    }
  })
  expect((await titles()).a).toBeNull()
  await editTabs((session) => {
    session.terminalLayoutsByTabId['tab-a']!.titlesByLeafId![LEAF.a] = 'MANGO own pane'
  })
  expect((await titles()).a).toBe('MANGO own pane')

  // A rename while asleep shows at once.
  await editTabs((session) => {
    tab(session, 'tab-a').customTitle = 'Renamed while asleep'
  })
  expect((await titles()).a).toBe('Renamed while asleep')
  // Every name and reply came from saved data: listing read no transcript.
  expect(transcripts.reads).toBe(0)
})

const GUEST_PATH = '/home/u/.claude/projects/p/shared-session.jsonl'
const SCOPES = [
  { tab: 'tab-native', leaf: LEAF.a, connectionId: null, path: 'C:\\Users\\u\\.claude\\x.jsonl' },
  { tab: 'tab-ubuntu', leaf: LEAF.b, connectionId: 'wsl:Ubuntu', path: GUEST_PATH },
  { tab: 'tab-debian', leaf: SIBLING_LEAF, connectionId: 'wsl:Debian', path: GUEST_PATH }
] as const

/** One provider conversation id run natively, in Ubuntu and in Debian, each in its own tab. */
function scopedSession(worktreeId: string): WorkspaceSessionState {
  const session = workspaceSession(worktreeId)
  return {
    ...session,
    tabsByWorktree: {
      [worktreeId]: SCOPES.map((scope, index) => ({
        ...session.tabsByWorktree[worktreeId]![0]!,
        id: scope.tab,
        title: `Claude in ${scope.tab}`,
        sortOrder: index
      }))
    },
    terminalLayoutsByTabId: Object.fromEntries(
      SCOPES.map((scope) => [
        scope.tab,
        {
          root: { type: 'leaf' as const, leafId: scope.leaf },
          activeLeafId: scope.leaf,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      ])
    )
  }
}

async function sleptScopes(root: string, worktreeId: string) {
  const app = await openApp(root, worktreeId, () => scopedSession(worktreeId))
  const ids: Record<string, OrcaSessionId> = {}
  for (const scope of SCOPES) {
    const paneKey = makePaneKey(scope.tab, scope.leaf)
    const event = normalizeHookPayload(
      createHookListenerState(),
      'claude',
      buildBody(
        {
          hook_event_name: 'Stop',
          session_id: 'shared-session',
          transcript_path: scope.path,
          last_assistant_message: `reply in ${scope.tab}`
        },
        { paneKey, tabId: scope.tab }
      ),
      'production'
    )
    app.server.ingestRemote(event!, scope.connectionId)
    await settle()
    ids[scope.tab] = orcaId(app.row(paneKey)?.orcaSessionId)
  }
  const capture = await captureWorktreeSleepResumeRecords({
    worktreeId,
    paneKeysByPtyId: new Map(
      SCOPES.map((scope) => [scope.tab, [makePaneKey(scope.tab, scope.leaf)]])
    ),
    launchByPtyId: new Map(),
    readRows: () => app.server.getStatusSnapshot(),
    checkAgentPresence: null,
    capturedAt: CAPTURED_AT
  })
  for (const scope of SCOPES) {
    app.server.dropStatusEntry(makePaneKey(scope.tab, scope.leaf), { preserveResumeIdentity: true })
  }
  await app.commit((session) =>
    applyWorktreeSleepResumeRecords(
      session,
      capture,
      SCOPES.map((scope) => scope.tab)
    )
  )
  await app.quit()
  return ids
}

async function onWindows<T>(run: () => Promise<T>): Promise<T> {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
}

const readById = (runtime: OrcaRuntimeService, orcaSessionId: OrcaSessionId) =>
  readAgentConversation(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a terminal read uses only the runtime's sleeping records.
    { runtime } as unknown as RpcContext,
    { kind: 'terminal', orcaSessionId },
    {}
  )

it('keeps each WSL distro and the native agent apart through sleep and restart, by its own ID', async () => {
  const root = directory()
  const worktreeId = `${REPO_ID}::${directory()}`
  const ids = await sleptScopes(root, worktreeId)
  expect(new Set(Object.values(ids)).size).toBe(3)
  const app = await openApp(root, worktreeId)

  await onWindows(async () => {
    const listed = (await listAgentConversations(app.runtime, 100)).agents
    for (const scope of SCOPES) {
      expect(
        listed.find((row) => row.paneKey === makePaneKey(scope.tab, scope.leaf))
      ).toMatchObject({
        orcaSessionId: ids[scope.tab],
        state: 'asleep',
        lastAssistantMessage: `reply in ${scope.tab}`
      })
    }
    for (const scope of SCOPES.slice(1)) {
      expect(
        await showAgentConversation(app.runtime, {
          kind: 'terminal',
          orcaSessionId: ids[scope.tab]!
        })
      ).toMatchObject({ places: [{ paneKey: makePaneKey(scope.tab, scope.leaf) }] })
      expect(await readById(app.runtime, ids[scope.tab]!)).toMatchObject({
        entries: [{ text: scope.connectionId!.slice('wsl:'.length) }]
      })
    }
  })
  expect(transcripts.guestReads).toEqual([
    { wslDistro: 'Ubuntu', transcriptPath: GUEST_PATH },
    { wslDistro: 'Debian', transcriptPath: GUEST_PATH }
  ])
})

it('finds an older WSL record only by evidence it names, and says why one without it has no ID', async () => {
  const root = directory()
  const worktreeId = `${REPO_ID}::${directory()}`
  const ids = await sleptScopes(root, worktreeId)
  const app = await openApp(root, worktreeId)
  // Records an older Orca saved: no distro field, and the Debian one names its distro in a UNC path.
  const legacy = structuredClone(app.store.getWorkspaceSession().sleepingAgentSessionsByPaneKey!)
  for (const record of Object.values(legacy)) {
    delete record.wslDistro
    if (record.tabId === 'tab-debian') {
      record.providerSession.transcriptPath =
        '\\\\wsl.localhost\\Debian\\home\\u\\.claude\\projects\\p\\shared-session.jsonl'
    }
  }
  // Saved with no record before it, as an older Orca left it; no row of theirs was restored.
  await app.commit((session) => ({ ...session, sleepingAgentSessionsByPaneKey: undefined }))
  await app.commit((session) => ({ ...session, sleepingAgentSessionsByPaneKey: legacy }))
  for (const scope of SCOPES) {
    app.server.dropStatusEntry(makePaneKey(scope.tab, scope.leaf), {
      preserveResumeIdentity: false
    })
  }

  await onWindows(async () => {
    const listed = (await listAgentConversations(app.runtime, 100)).agents
    const row = (tab: string) => listed.find((candidate) => candidate.paneKey.startsWith(`${tab}:`))
    expect(row('tab-native')).toMatchObject({ orcaSessionId: ids['tab-native'] })
    expect(row('tab-debian')).toMatchObject({ orcaSessionId: ids['tab-debian'] })
    expect(row('tab-ubuntu')).toMatchObject({ orcaSessionId: null, savedWithoutDistro: true })
    expect(
      await showAgentConversation(app.runtime, {
        kind: 'terminal',
        orcaSessionId: ids['tab-ubuntu']!
      })
    ).toEqual({
      orcaSessionId: ids['tab-ubuntu'],
      kind: 'terminal',
      places: [],
      savedWithoutDistro: true
    })
    await expect(readById(app.runtime, ids['tab-ubuntu']!)).rejects.toMatchObject({
      code: 'agent_no_transcript',
      message: `Orca can't read agent ${ids['tab-ubuntu']} while it's asleep: it was saved before Orca recorded which WSL distro it ran in. Open its tab to wake it, then read it again.`
    })
  })
})

it('gives a record from a direct SSH relay no ID or place on this host', async () => {
  const root = directory()
  const worktreeId = `${REPO_ID}::${directory()}`
  const app = await openApp(root, worktreeId, () => workspaceSession(worktreeId))
  claudeTurn(app.server, PANE.a, 'tab-a', 'MANGO')
  await settle()
  await sleepWorkspace(app, worktreeId)
  await app.commit((session) => {
    session.sleepingAgentSessionsByPaneKey![PANE.a]!.connectionId = 'ssh-target-box'
    return session
  })
  app.server.identityClient.idsOfKeysKeys = 0

  expect((await app.list()).a).toBeUndefined()
  expect(app.server.identityClient.idsOfKeysKeys).toBe(0)
})
