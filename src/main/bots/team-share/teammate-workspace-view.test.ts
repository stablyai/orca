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

// The owner's host: a shared bot whose home parents one worker worktree, and the owner's own repo,
// worktree and folder beside it.
const SHARED = makeTestBot({ id: 'bot-shared', folderWorkspaceId: 'home-shared' })
const HOME = 'folder:home-shared'
const WORKER = 'repo-agent::/work/agent-task'
const OWNERS = 'repo-owner::/work/owner-task'
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
const repo = (id: string, projectGroupId: string) => ({ id, path: `/r/${id}`, projectGroupId })

let directory: string
let db: OrchestrationDb
let runtime: OrcaRuntimeService
let dispatcher: RpcDispatcher

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'teammate-workspaces-'))
  db = new OrchestrationDb(join(directory, 'orchestration.db'))
  const store = {
    getRepos: () => [repo('repo-agent', 'group-agent'), repo('repo-owner', 'group-owner')],
    getBots: () => [SHARED],
    getFolderWorkspaces: () => [folder('home-shared'), folder('owner-folder')],
    // The worker was started from the bot's home: its record parents it there.
    getAllWorkspaceLineage: () => ({
      [`worktree:${WORKER}`]: {
        childWorkspaceKey: `worktree:${WORKER}`,
        parentWorkspaceKey: HOME,
        origin: 'orchestration',
        capture: 'confirmed',
        createdAt: 1
      }
    }),
    getSettings: () => ({})
  }
  runtime = new OrcaRuntimeService(fake(store))
  // The host's cached worktree scan, which the set reads.
  vi.spyOn(
    fake<{ listResolvedWorktreeSnapshot: () => Promise<unknown> }>(runtime),
    'listResolvedWorktreeSnapshot'
  ).mockResolvedValue({
    worktrees: [worktree(WORKER, 'repo-agent'), worktree(OWNERS, 'repo-owner')],
    platformByRepoId: new Map()
  })
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
    [OWNERS_WORKSPACE_CHAT, WORKER]
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

  it('streams only the agent’s workspaces’ events and none of the host’s own', async () => {
    const stream = async (scope: RpcCallerScope) => {
      const received: z.infer<typeof StreamedEvent>[] = []
      let subscriptionId = ''
      let ready!: () => void
      const isReady = new Promise<void>((resolve) => (ready = resolve))
      const done = dispatcher.dispatchStreamingObjects(
        { id: 's1', authToken: '', method: 'runtime.clientEvents.subscribe', params: {} },
        (response) => {
          const event = response.ok ? StreamedEvent.parse(response.result) : null
          if (event?.type === 'ready') {
            subscriptionId = event.subscriptionId ?? ''
            ready()
          } else if (event && event.type !== 'end') {
            received.push(event)
          }
        },
        { ...options(scope), connectionId: `c-${scope.kind}` }
      )
      await isReady
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
      // As the host's own producers publish them.
      const host = fake<{ emitClientEvent: (event: RuntimeClientEvent) => void }>(runtime)
      for (const event of events) {
        host.emitClientEvent(event)
      }
      await new Promise((resolve) => setTimeout(resolve, 10))
      runtime.cleanupSubscription(subscriptionId)
      await done
      return received.map(
        (event) => `${event.type}:${event.batch?.worktreeId ?? event.worktreeId ?? event.repoId}`
      )
    }
    expect(await stream(TEAMMATE)).toEqual([
      'worktreesChanged:repo-agent',
      `pullRequestChanged:${WORKER}`,
      `terminalSideEffects:${HOME}`
    ])
    expect(await stream(OWNER)).toHaveLength(9)
  })
})
