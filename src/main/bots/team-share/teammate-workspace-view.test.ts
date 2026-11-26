import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OWNER_ACTS_FOR, type BotRequestAsker } from '../../../shared/bots/bot-acts-for'
import { BOTS_SHARE_WORKSPACES_CAPABILITY } from '../../../shared/bot-runtime-capabilities'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { setStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-host'
import { OrchestrationDb } from '../../runtime/orchestration/db/orchestration-db'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import type { RpcCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import { RpcDispatcher } from '../../runtime/rpc/dispatcher'
import type { RpcDispatchStreamingOptions } from '../../runtime/rpc/dispatch/dispatcher-stream-options'
import { ALL_RPC_METHODS } from '../../runtime/rpc/methods/rpc-method-registry'
import { botShareCallerScopeOf } from '../../runtime/rpc/server/pairing/device-principal'
import type { BotShareDevice } from '../../runtime/rpc/server/pairing/bot-share-device-store'
import { makeTestBot } from '../bot.test-fixture'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/remote-runtime/protocol/electron-remote-runtime-client-capabilities'
import { remoteRuntimeClientCapabilities } from '../../../shared/remote-runtime/remote-runtime-client-capabilities'
import type { RpcContext, RpcMethod } from '../../runtime/rpc/core'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/published-layout/workspace-layout-published'
import type { WorkspaceLayoutStreamEvent } from '../../../shared/workspace-layout/published-layout/workspace-layout-stream-frames'
import { admitTeammateCall } from './teammate-call-admission'
import { teammateTerminalAdmission } from './teammate-call-targets'
import { installMultiplexSubscribeFrame } from '../../runtime/rpc/methods/terminal/terminal-multiplex-subscribe-frame'
import type { TerminalMultiplexConnection } from '../../runtime/rpc/methods/terminal/terminal-multiplex-connection'
import { encodeTerminalStreamJson } from '../../../shared/terminal/stream/terminal-stream-protocol'

// The owner's host: a shared bot whose home parents one worker worktree, and the owner's own repo,
// worktree and folder beside it.
const SHARED = makeTestBot({ id: 'bot-shared', folderWorkspaceId: 'home-shared' })
const HOME = 'folder:home-shared'
const WORKER = 'repo-agent::/work/agent-task'
const OWNERS = 'repo-owner::/work/owner-task'
// The owner's own worktree in the agent's repo: never a teammate's.
const OWNERS_IN_AGENT_REPO = 'repo-agent::/work/owner-in-agent-repo'
const WORKER_2 = 'repo-agent::/work/agent-task-2'
const alice: BotRequestAsker = {
  kind: 'person',
  source: 'orca',
  userId: 'acct-alice',
  workspaceId: null,
  role: 'member'
}
const chat = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ALICES_CHAT = chat(1)
const OWNERS_CHAT = chat(2)
const OWNERS_WORKSPACE_CHAT = chat(3)
const OWNERS_OTHER_CHAT = chat(4)

const device = fake<BotShareDevice>({ botId: SHARED.id, accountId: 'acct-alice', name: 'Alice' })
const TEAMMATE = botShareCallerScopeOf(device, [BOTS_SHARE_WORKSPACES_CAPABILITY])
const CHATS_ONLY = botShareCallerScopeOf(device, [])
const OWNER: RpcCallerScope = { kind: 'owner' }

const worktree = (id: string, repoId: string) => ({
  id,
  repoId,
  path: id.split('::')[1],
  displayName: id,
  isArchived: false,
  isMainWorktree: false,
  lineage: null,
  parentWorktreeId: null,
  childWorktreeIds: []
})
const folder = (id: string) => ({ id, projectGroupId: `group-${id}`, path: `/f/${id}`, name: id })
const repo = (id: string, projectGroupId: string) => ({
  id,
  path: `/r/${id}`,
  projectGroupId,
  gitRemoteIdentity: { canonicalKey: `github.com/acme/gh-${id}` }
})

let directory: string
let db: OrchestrationDb
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher
let scanned: string[]
let lineage: Record<string, unknown>
const workerRecord = (id: string) => ({
  childWorkspaceKey: `worktree:${id}`,
  parentWorkspaceKey: HOME,
  origin: 'orchestration',
  capture: 'confirmed',
  createdAt: 1
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'teammate-workspaces-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  const store = {
    getRepos: () => [repo('repo-agent', 'group-agent'), repo('repo-owner', 'group-owner')],
    getBots: () => [SHARED],
    getFolderWorkspaces: () => [folder('home-shared'), folder('owner-folder')],
    // The worker was started from the bot's home: its record parents it there.
    getAllWorkspaceLineage: () => lineage,
    getSettings: () => ({})
  }
  scanned = [WORKER, OWNERS, OWNERS_IN_AGENT_REPO]
  lineage = { [`worktree:${WORKER}`]: workerRecord(WORKER) }
  runtime = new OrcaRuntimeService(fake(store))
  // The host's cached worktree scan, which the set reads.
  vi.spyOn(
    fake<{ listResolvedWorktreeSnapshot: () => Promise<unknown> }>(runtime),
    'listResolvedWorktreeSnapshot'
  ).mockImplementation(async () => ({
    worktrees: scanned.map((id) => worktree(id, id.split('::')[0])),
    platformByRepoId: new Map()
  }))
  vi.spyOn(runtime, 'getOrchestrationDb').mockReturnValue(db)
  vi.spyOn(runtime.bots, 'list').mockReturnValue([SHARED])
  vi.spyOn(runtime, 'listVisibleRepos').mockReturnValue(fake(store.getRepos()))
  vi.spyOn(runtime, 'listVisibleFolderWorkspaces').mockReturnValue(
    fake(store.getFolderWorkspaces())
  )
  vi.spyOn(runtime, 'listTerminals').mockResolvedValue(
    fake({
      terminals: [HOME, WORKER, OWNERS].map((worktreeId) => ({ worktreeId, handle: worktreeId })),
      totalCount: 3,
      truncated: false
    })
  )
  vi.spyOn(runtime, 'getWorktreePs').mockResolvedValue(
    fake({
      worktrees: [HOME, WORKER, OWNERS, 'folder:owner-folder'].map((worktreeId) => ({
        worktreeId
      })),
      totalCount: 4,
      truncated: false
    })
  )
  vi.spyOn(runtime, 'restoreStructuredAgentSessionTabs').mockResolvedValue(undefined)
  vi.spyOn(runtime, 'supportsAuthoritativeSessionTabsInventory').mockReturnValue(false)
  vi.spyOn(runtime, 'listAllMobileSessionTabs').mockResolvedValue([
    tabs(HOME, [ALICES_CHAT, OWNERS_CHAT]),
    tabs(WORKER, [OWNERS_WORKSPACE_CHAT]),
    tabs(OWNERS, [])
  ])
  // Chat records: Alice's and the owner's chats live in the bot's home.
  db.recordBotConversationActsFor(ALICES_CHAT, { actsFor: [alice] })
  db.recordBotConversationActsFor(OWNERS_CHAT, { actsFor: [...OWNER_ACTS_FOR] })
  const workspaceOf = new Map([
    [ALICES_CHAT, HOME],
    [OWNERS_CHAT, HOME],
    [OWNERS_WORKSPACE_CHAT, WORKER],
    [OWNERS_OTHER_CHAT, OWNERS]
  ])
  setStructuredAgentSessionHost(
    fake<StructuredAgentSessionHost>({
      deps: {
        store: {
          listConversations: () => [],
          getConversation: (id: string) =>
            workspaceOf.has(id) ? { location: { workspaceId: workspaceOf.get(id) } } : null
        }
      }
    })
  )
  dispatcher = new RpcDispatcher({ runtime, methods: ALL_RPC_METHODS })
})

afterEach(() => {
  vi.restoreAllMocks()
  setStructuredAgentSessionHost(null)
  db.close()
  rmSync(directory, { recursive: true, force: true })
})

function tabs(worktree: string, sessionIds: string[]): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'e',
    snapshotVersion: 1,
    activeGroupId: 'g',
    activeTabId: sessionIds.at(-1) ?? null,
    activeTabType: sessionIds.length > 0 ? 'agent-session' : null,
    tabGroups: [{ id: 'g', activeTabId: sessionIds[0] ?? null, tabOrder: sessionIds }],
    tabs: sessionIds.map((sessionId) => ({
      type: 'agent-session',
      id: sessionId,
      title: sessionId,
      sessionId,
      agent: 'claude',
      isActive: false
    }))
  }
}

function options(scope: RpcCallerScope): RpcDispatchStreamingOptions {
  return {
    callerScope: scope,
    pairedDeviceId: 'share-device',
    clientKind: 'runtime',
    clientCapabilities: remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
  }
}

/** A partial fake: only the fields the code under test reads. */
function fake<T>(value: unknown): T {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a test fake carries only the fields the code under test reads.
  return value as T
}

async function call(scope: RpcCallerScope, method: string, params?: unknown) {
  const response = await dispatcher.dispatch(
    { id: 'r1', authToken: '', method, params },
    options(scope)
  )
  return response.ok ? { result: response.result } : response.error
}

/** `field`'s rows of a call's answer, each by `key`. */
async function listed(scope: RpcCallerScope, method: string, field: string, key = 'id') {
  const answer = z
    .object({ result: z.record(z.string(), z.unknown()) })
    .parse(await call(scope, method, {}))
  return z
    .array(z.looseObject({ [key]: z.string() }))
    .parse(answer.result[field])
    .map((row) => row[key])
}

const Tabs = z.looseObject({
  worktree: z.string(),
  tabs: z.array(z.looseObject({ id: z.string() })),
  tabGroups: z.array(z.looseObject({ tabOrder: z.array(z.string()) }))
})
const StreamedEvent = z.looseObject({
  type: z.string(),
  subscriptionId: z.string().optional(),
  worktreeId: z.string().optional(),
  repoId: z.string().optional(),
  batch: z.looseObject({ worktreeId: z.string() }).optional()
})

describe('a workspace teammate on a shared agent', () => {
  it('is admitted to workspace methods only when its Orca works in workspaces, never to the owner’s own', async () => {
    expect(await call(CHATS_ONLY, 'repo.list', {})).toMatchObject({ code: 'forbidden' })
    expect(await call(TEAMMATE, 'repo.list', {})).toHaveProperty('result')
    for (const method of ['notifications.subscribe', 'accounts.subscribe', 'settings.set']) {
      expect(await call(TEAMMATE, method, {})).toMatchObject({ code: 'forbidden' })
    }
  })

  it('reads folders in the agent’s workers’ workspaces, which a chats-only teammate cannot', async () => {
    const read = vi
      .spyOn(runtime, 'readFileExplorerDir')
      .mockResolvedValue(fake([{ name: 'README.md', isDirectory: false }]))
    const readDir = { worktree: `id:${WORKER}`, relativePath: '' }
    expect(await call(TEAMMATE, 'files.readDir', readDir)).toMatchObject({
      result: [{ name: 'README.md' }]
    })
    expect(read).toHaveBeenCalledWith(`id:${WORKER}`, '')
    read.mockClear()
    expect(await call(CHATS_ONLY, 'files.readDir', readDir)).toMatchObject({ code: 'not_found' })
    expect(read).not.toHaveBeenCalled()
  })

  it('lists only the agent’s home and its workers’ workspaces; the owner lists everything', async () => {
    expect(await listed(TEAMMATE, 'repo.list', 'repos')).toEqual(['repo-agent'])
    expect(await listed(OWNER, 'repo.list', 'repos')).toEqual(['repo-agent', 'repo-owner'])
    expect(await listed(TEAMMATE, 'folderWorkspace.list', 'folderWorkspaces')).toEqual([
      'home-shared'
    ])
    expect(await listed(OWNER, 'folderWorkspace.list', 'folderWorkspaces')).toEqual([
      'home-shared',
      'owner-folder'
    ])
    expect(await listed(TEAMMATE, 'worktree.ps', 'worktrees', 'worktreeId')).toEqual([HOME, WORKER])
    expect(await call(TEAMMATE, 'worktree.ps', {})).toMatchObject({ result: { totalCount: 2 } })
    expect(await listed(OWNER, 'worktree.ps', 'worktrees', 'worktreeId')).toHaveLength(4)
    expect(await listed(TEAMMATE, 'terminal.list', 'terminals', 'worktreeId')).toEqual([
      HOME,
      WORKER
    ])
    expect(await listed(OWNER, 'terminal.list', 'terminals', 'worktreeId')).toEqual([
      HOME,
      WORKER,
      OWNERS
    ])
  })

  it('sees only its own tabs in the agent’s home and every tab in its workers’ workspaces', async () => {
    const listAll = async (scope: RpcCallerScope) => {
      const answer = z
        .object({ result: z.object({ snapshots: z.array(Tabs) }) })
        .parse(await call(scope, 'session.tabs.listAll'))
      return answer.result.snapshots.map((snapshot) => ({
        worktree: snapshot.worktree,
        tabs: snapshot.tabs.map((tab) => tab.id),
        order: snapshot.tabGroups[0]?.tabOrder
      }))
    }
    expect(await listAll(TEAMMATE)).toEqual([
      { worktree: HOME, tabs: [ALICES_CHAT], order: [ALICES_CHAT] },
      { worktree: WORKER, tabs: [OWNERS_WORKSPACE_CHAT], order: [OWNERS_WORKSPACE_CHAT] }
    ])
    expect((await listAll(OWNER)).map((snapshot) => snapshot.tabs)).toEqual([
      [ALICES_CHAT, OWNERS_CHAT],
      [OWNERS_WORKSPACE_CHAT],
      []
    ])
  })

  it('reads and sends to chats in the agent’s workers’ workspaces, and none of the owner’s', async () => {
    const history = (scope: RpcCallerScope, sessionId: string) =>
      call(scope, 'agentSession.history', { sessionId, direction: 'tail' })
    expect(await history(TEAMMATE, OWNERS_WORKSPACE_CHAT)).not.toMatchObject({ code: 'not_found' })
    expect(await history(CHATS_ONLY, OWNERS_WORKSPACE_CHAT)).toMatchObject({ code: 'not_found' })
    expect(await history(TEAMMATE, OWNERS_OTHER_CHAT)).toMatchObject({ code: 'not_found' })
  })

  it('reads the host’s full status as a paired client does, without the update offer', async () => {
    vi.spyOn(runtime, 'machineNameReady').mockResolvedValue(undefined)
    expect(await call(TEAMMATE, 'status.get', {})).toMatchObject({
      result: { pairedDeviceId: 'share-device' }
    })
    expect(await call(TEAMMATE, 'status.get', {})).not.toMatchObject({
      result: { remoteUpdateSupport: expect.anything() }
    })
    expect(await call(CHATS_ONLY, 'status.get', {})).not.toMatchObject({
      result: { pairedDeviceId: expect.anything() }
    })
  })

  it('streams only the agent’s workspaces’ events and none of the host’s own', async () => {
    const summarize = (event: z.infer<typeof StreamedEvent>) =>
      `${event.type}:${event.batch?.worktreeId ?? event.worktreeId ?? event.repoId}`
    const events: RuntimeClientEvent[] = [
      { type: 'worktreesChanged', repoId: 'repo-agent' },
      { type: 'worktreesChanged', repoId: 'repo-owner' },
      { type: 'pullRequestChanged', worktreeId: OWNERS, repoId: 'repo-owner', branch: 'b' },
      { type: 'pullRequestChanged', worktreeId: WORKER, repoId: 'repo-agent', branch: 'b' },
      {
        type: 'terminalSideEffects',
        batch: { ptyId: 'p1', seq: 1, facts: [{ kind: 'bell' }], worktreeId: HOME }
      },
      {
        type: 'terminalSideEffects',
        batch: { ptyId: 'p2', seq: 1, facts: [{ kind: 'bell' }], worktreeId: OWNERS }
      },
      { type: 'activateWorktree', repoId: 'repo-agent', worktreeId: WORKER },
      { type: 'settingsChanged', keys: ['theme'] },
      { type: 'botsChanged', botIds: ['bot-other'] }
    ]
    expect((await clientEvents(TEAMMATE, events)).map(summarize)).toEqual([
      'worktreesChanged:repo-agent',
      `pullRequestChanged:${WORKER}`,
      `terminalSideEffects:${HOME}`
    ])
    expect(await clientEvents(OWNER, events)).toHaveLength(9)
  })

  it('tells a teammate when the agent’s last worker leaves a repo, without the owner’s rows', async () => {
    const removed = await clientEvents(TEAMMATE, [], () => {
      scanned = [OWNERS, OWNERS_IN_AGENT_REPO]
      return [
        {
          type: 'worktreesChanged',
          repoId: 'repo-agent',
          sortOrders: [
            { worktreeId: WORKER, sortOrder: 1 },
            { worktreeId: OWNERS_IN_AGENT_REPO, sortOrder: 2 }
          ]
        }
      ]
    })
    expect(removed).toEqual([
      { type: 'worktreesChanged', repoId: 'repo-agent' },
      { type: 'reposChanged' },
      {
        type: 'worktreesChanged',
        repoId: 'repo-agent',
        sortOrders: [{ worktreeId: WORKER, sortOrder: 1 }]
      }
    ])
  })

  it('streams a new worker workspace’s first tabs and a removed one’s removal', async () => {
    const tabStream = await openTabStream(TEAMMATE)
    const host = fake<{ emitClientEvent: (event: RuntimeClientEvent) => void }>(runtime)
    // Made: its record lands, its repo is announced, and its first chat tab follows at once.
    scanned = [...scanned, WORKER_2]
    lineage = { ...lineage, [`worktree:${WORKER_2}`]: workerRecord(WORKER_2) }
    host.emitClientEvent({ type: 'worktreesChanged', repoId: 'repo-agent' })
    tabStream.change(tabs(WORKER_2, [OWNERS_WORKSPACE_CHAT]), 2)
    // Removed: the set drops it before its removal reaches the stream.
    scanned = scanned.filter((id) => id !== WORKER)
    host.emitClientEvent({ type: 'worktreesChanged', repoId: 'repo-agent' })
    tabStream.change({ ...tabs(WORKER, []), removed: true }, 3)
    // The owner's own workspace never reaches them.
    tabStream.change(tabs(OWNERS, [OWNERS_OTHER_CHAT]), 4)
    await vi.waitFor(() => expect(tabStream.updates()).toHaveLength(2))
    expect(tabStream.updates()).toEqual([
      { worktree: WORKER_2, removed: undefined },
      { worktree: WORKER, removed: true }
    ])
    tabStream.close()
  })
})

describe('what a workspace teammate’s call may name', () => {
  /** Whether the tier admits `method` with `params`, before its handler runs. */
  async function admits(method: string, params: unknown) {
    const found = ALL_RPC_METHODS.find((candidate) => candidate.name === method)
    if (!found) {
      throw new Error(`no method ${method}`)
    }
    const context = fake<RpcContext>({ runtime, callerScope: TEAMMATE })
    return !(
      'refusal' in
      (await admitTeammateCall(context, TEAMMATE, { method: fake<RpcMethod>(found), params }))
    )
  }

  it('keeps every call a chats-only teammate already makes', async () => {
    for (const method of ['pairing.getEndpoints', 'botShare.provisionPhone', 'bots.github.state']) {
      expect(await call(TEAMMATE, method, {})).not.toMatchObject({ code: 'forbidden' })
    }
  })

  it('starts a chat in the agent’s workspaces under a new id, and none in the owner’s', async () => {
    const create = (worktree: string, sessionId: string) => ({
      envelope: { sessionId },
      worktree: `id:${worktree}`,
      agent: 'codex'
    })
    expect(await admits('agentSession.create', create(WORKER, chat(9)))).toBe(true)
    expect(await admits('agentSession.ensure', create(HOME, chat(9)))).toBe(true)
    expect(await admits('agentSession.create', create(OWNERS, chat(9)))).toBe(false)
    // An id the owner's chat already holds is not a new chat.
    expect(await admits('agentSession.ensure', create(WORKER, OWNERS_OTHER_CHAT))).toBe(false)
  })

  it('reads an agent CLI session running in the agent’s workspaces, by its provider id', async () => {
    vi.spyOn(runtime, 'getAgentProviderSessionRows').mockReturnValue(
      fake([
        { providerSession: { id: 'cli-agent' }, worktreeId: WORKER, paneKey: 'p1' },
        { providerSession: { id: 'cli-owner' }, worktreeId: OWNERS, paneKey: 'p2' }
      ])
    )
    expect(await admits('nativeChat.readSession', { sessionId: 'cli-agent' })).toBe(true)
    expect(await admits('nativeChat.subscribe', { sessionId: 'cli-owner' })).toBe(false)
    expect(await admits('nativeChat.readSession', { sessionId: 'cli-unknown' })).toBe(false)
  })

  it('works on GitHub repos the agent’s workspaces push to, by slug', async () => {
    const slug = (name: string) => ({ owner: 'acme', repo: name, number: 1 })
    expect(await admits('github.project.workItemDetailsBySlug', slug('gh-repo-agent'))).toBe(true)
    expect(await admits('github.project.workItemDetailsBySlug', slug('gh-repo-owner'))).toBe(false)
  })

  it('refuses a call that names no workspace, page or terminal rather than act on the owner’s', async () => {
    vi.spyOn(runtime, 'browserTabList').mockResolvedValue(
      fake({ tabs: [{ browserPageId: 'page-agent' }] })
    )
    for (const [method, params] of [
      ['browser.tabCurrent', {}],
      ['browser.snapshot', { page: 'page-agent' }],
      ['workspacePorts.scan', {}],
      ['terminal.resolveActive', {}],
      ['orchestration.workerStart', { task: 'task-1', from: 'term_coord', agent: 'codex' }],
      ['session.tabs.list', { worktree: `id:${OWNERS}` }]
    ] as const) {
      expect(await admits(method, params), method).toBe(false)
    }
    expect(await admits('browser.snapshot', { page: 'page-agent', worktree: `id:${WORKER}` })).toBe(
      true
    )
    expect(await admits('browser.snapshot', { page: 'page-owner', worktree: `id:${WORKER}` })).toBe(
      false
    )
    expect(await admits('session.tabs.list', { worktree: `id:${WORKER}` })).toBe(true)
  })

  it('streams only the agent’s terminals, judged as the set is when each is subscribed', async () => {
    vi.spyOn(runtime, 'getTerminalWorktreeIdForHandle').mockImplementation((handle) => handle)
    // Past admission, a terminal with no live pane ends as no_connected_pty.
    vi.spyOn(runtime, 'resolveLiveLeafForHandle').mockReturnValue(null)
    const refusals: string[] = []
    const connection = (scope: RpcCallerScope) => {
      const state = fake<TerminalMultiplexConnection>({
        runtime,
        admitsTerminal: teammateTerminalAdmission(fake({ runtime, callerScope: scope })),
        streams: new Map(),
        closed: false,
        sendStreamError: (_streamId: number, code: string) => void refusals.push(code),
        emit: () => {},
        detachStream: () => {},
        cancelPendingPtyWaits: () => {}
      })
      installMultiplexSubscribeFrame(state)
      return (terminal: string) =>
        state.handleSubscribeFrame(encodeTerminalStreamJson({ streamId: 1, terminal }))
    }
    const teammate = connection(TEAMMATE)
    await teammate(WORKER)
    await teammate(OWNERS)
    // The worker leaves the agent's workspaces: its terminal is no longer theirs.
    scanned = scanned.filter((id) => id !== WORKER)
    await teammate(WORKER)
    await connection(OWNER)(OWNERS)
    expect(refusals).toEqual([
      'no_connected_pty',
      'terminal_not_found',
      'terminal_not_found',
      'no_connected_pty'
    ])
  })

  it('streams layouts of the agent’s workspaces in order, the home with only their own chats', async () => {
    const layout = (worktreeId: string, sessionIds: string[]): PublishedWorkspaceLayout =>
      fake({
        worktreeId,
        groups: [{ id: 'g', tabIds: [...sessionIds, 'term'] }],
        tabs: [
          ...sessionIds.map((id) => ({ id, kind: 'agent-session', entityId: id })),
          { id: 'term', kind: 'terminal', entityId: 'pty' }
        ],
        editorFiles: [],
        browserTabs: []
      })
    let feed: ((event: WorkspaceLayoutStreamEvent) => void) | undefined
    vi.spyOn(runtime, 'subscribeWorkspaceLayouts').mockImplementation((listener) => {
      feed = listener
      return fake({
        snapshot: [
          { key: HOME, layout: layout(HOME, [ALICES_CHAT, OWNERS_CHAT]) },
          { key: WORKER, layout: layout(WORKER, [OWNERS_WORKSPACE_CHAT]) },
          { key: OWNERS, layout: layout(OWNERS, [OWNERS_OTHER_CHAT]) }
        ],
        seq: 1,
        unsubscribe: () => {}
      })
    })
    const Frame = z.looseObject({
      type: z.string(),
      key: z.string().optional(),
      subscriptionId: z.string().optional(),
      layout: z.looseObject({ tabs: z.array(z.looseObject({ id: z.string() })) }).optional(),
      workspaces: z
        .array(
          z.looseObject({
            key: z.string(),
            layout: z.looseObject({ tabs: z.array(z.looseObject({ id: z.string() })) })
          })
        )
        .optional()
    })
    const frames: z.infer<typeof Frame>[] = []
    void dispatcher.dispatchStreamingObjects(
      { id: 'l1', authToken: '', method: 'layout.subscribe', params: {} },
      (response) => void (response.ok && frames.push(Frame.parse(response.result))),
      { ...options(TEAMMATE), connectionId: 'c-layout' }
    )
    await vi.waitFor(() => expect(frames[0]?.type).toBe('snapshot'))
    expect(
      frames[0]?.workspaces?.map((entry) => [entry.key, entry.layout.tabs.map((tab) => tab.id)])
    ).toEqual([
      [HOME, [ALICES_CHAT]],
      // A worker's workspace goes whole, as it does to the owner.
      [WORKER, [OWNERS_WORKSPACE_CHAT, 'term']]
    ])
    const host = fake<{ emitClientEvent: (event: RuntimeClientEvent) => void }>(runtime)
    // A new worker's first layout, judged after the re-read its announcement causes.
    scanned = [...scanned, WORKER_2]
    lineage = { ...lineage, [`worktree:${WORKER_2}`]: workerRecord(WORKER_2) }
    host.emitClientEvent({ type: 'worktreesChanged', repoId: 'repo-agent' })
    feed?.({ type: 'workspace', key: WORKER_2, layout: layout(WORKER_2, []) })
    // A shown worker's removal, after the set dropped it.
    scanned = scanned.filter((id) => id !== WORKER)
    host.emitClientEvent({ type: 'worktreesChanged', repoId: 'repo-agent' })
    feed?.({ type: 'removed', key: WORKER })
    feed?.({ type: 'workspace', key: OWNERS, layout: layout(OWNERS, []) })
    feed?.({ type: 'workspace', key: HOME, layout: layout(HOME, [OWNERS_CHAT, ALICES_CHAT]) })
    await vi.waitFor(() => expect(frames).toHaveLength(4))
    expect(frames.slice(1).map((frame) => `${frame.type}:${frame.key}`)).toEqual([
      `workspace:${WORKER_2}`,
      `removed:${WORKER}`,
      `workspace:${HOME}`
    ])
    // The home goes out as they see it: the owner's chat and the home's terminal stay the owner's.
    expect(frames[3]?.layout?.tabs.map((tab) => tab.id)).toEqual([ALICES_CHAT])
    runtime.cleanupSubscription(`layout:c-layout:${frames[0]?.subscriptionId}`)
  })
})

const StreamedTabs = z.looseObject({
  type: z.string(),
  worktree: z.string().optional(),
  removed: z.boolean().optional()
})

/** A teammate's session.tabs.subscribeAll, its host-side change feed in the test's hands. */
async function openTabStream(scope: RpcCallerScope) {
  let feed: ((snapshot: unknown, changeSequence: number) => void) | undefined
  vi.spyOn(runtime, 'onMobileSessionTabsChanged').mockImplementation((listener) => {
    feed = fake(listener)
    return () => {}
  })
  vi.spyOn(runtime, 'listAllMobileSessionTabsWithChangeSequence').mockResolvedValue(
    fake({ snapshots: [tabs(HOME, [ALICES_CHAT]), tabs(WORKER, [])], changeSequence: 1 })
  )
  const frames: z.infer<typeof StreamedTabs>[] = []
  void dispatcher.dispatchStreamingObjects(
    { id: 't1', authToken: '', method: 'session.tabs.subscribeAll', params: null },
    (response) => {
      if (response.ok) {
        frames.push(StreamedTabs.parse(response.result))
      }
    },
    { ...options(scope), connectionId: 'c-tabs' }
  )
  await vi.waitFor(() => expect(frames.some((frame) => frame.type === 'snapshots')).toBe(true))
  return {
    change: (snapshot: unknown, changeSequence: number) => feed?.(snapshot, changeSequence),
    updates: () =>
      frames
        .filter((frame) => frame.type === 'updated')
        .map((frame) => ({ worktree: frame.worktree, removed: frame.removed })),
    close: () => runtime.cleanupSubscription('session.tabs:c-tabs:*')
  }
}

/** The client-events a caller receives for `events`, each judged as the host publishes it; `moving`
 *  first changes the host and returns the events that announce it. */
async function clientEvents(
  scope: RpcCallerScope,
  events: RuntimeClientEvent[],
  moving?: () => RuntimeClientEvent[]
): Promise<z.infer<typeof StreamedEvent>[]> {
  const received: z.infer<typeof StreamedEvent>[] = []
  let subscriptionId = ''
  const done = dispatcher.dispatchStreamingObjects(
    { id: 's1', authToken: '', method: 'runtime.clientEvents.subscribe', params: {} },
    (response) => {
      const event = response.ok ? StreamedEvent.parse(response.result) : null
      if (event?.type === 'ready') {
        subscriptionId = event.subscriptionId ?? ''
      } else if (event && event.type !== 'end') {
        received.push(event)
      }
    },
    { ...options(scope), connectionId: `c-${scope.kind}` }
  )
  await vi.waitFor(() => expect(subscriptionId).not.toBe(''))
  // As the host's own producers publish them, then one every caller receives, to know all arrived.
  const host = fake<{ emitClientEvent: (event: RuntimeClientEvent) => void }>(runtime)
  for (const event of [...events, ...(moving?.() ?? []), { type: 'agentListChanged' as const }]) {
    host.emitClientEvent(event)
  }
  await vi.waitFor(() => expect(received.at(-1)?.type).toBe('agentListChanged'))
  runtime.cleanupSubscription(subscriptionId)
  await done
  return received.slice(0, -1)
}
