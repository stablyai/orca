import { expect, it, vi } from 'vitest'
import {
  AuthorityRuntime,
  authorityProfile,
  openAuthorityRuntime,
  createC,
  B,
  root
} from './structured-agent-session-tab-authority.test-support'
import * as selection from './saved-structured-agent-session-restoration'
import * as founding from './agent-session/records/agent-session-founding-admission'
import * as state from './agent-session/records/agent-session-store-state'
import * as rows from './agent-session/records/agent-session-record-rows'
import * as journalFactory from '../native-chat/agent-session-journal/journal-store-factory'
import { stopStructuredAgentSessionRuntime } from './agent-session/structured-agent-session-runtime'
import { closeTestStores } from '../persistence/persistence-test-harness'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { chatTabCommandsSettled } from './session-layout-apply.test-fixture'
import {
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from './agent-session/records/agent-session-record-store-test-harness'
import * as seed from './agent-session/structured-agent-session-tab-index-seed'
import * as layoutLoad from '../../shared/workspace-layout/workspace-layout-load'
import * as layoutSave from '../../shared/workspace-layout/workspace-layout-save'
import { withChatTabChanges, type ChatTabChange } from './agent-session/agent-session-tab-layout'
import * as tabLayout from './agent-session/agent-session-tab-layout'
import * as tabCommands from '../../shared/workspace-layout/workspace-layout-tab-commands'
import * as removal from '../../shared/workspace-layout/workspace-layout-removal'
import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'
import { collectionVisits, fieldReads } from '../../shared/collection-visits.test-fixture'
import { ProfileStateSqliteAuthority } from '../persistence/profile-state/profile-state-sqlite-authority'
import type { ProfileStateDomainReplacement } from '../persistence/loading-store/profile-state-authority'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { structuredAgentSessionTabId } from '../../shared/agent-session/view/structured-agent-session-projection'
import type { TabGroupLayoutNode } from '../../shared/tab-types'

// CLI capability probing is outside tab authority and must not start a real CLI in this fixture.
vi.mock('../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
}))
const layoutOwner = vi.hoisted(() => ({ main: false }))
vi.mock('../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.main
  }
}))

it.each([10, 100])(
  'counts actual capture/materialization/projection work for %i selected chats',
  async (n) => {
    const ids = Array.from({ length: n }, (_, i) => `selected-${i.toString().padStart(5, '0')}`)
    const profile = await authorityProfile(ids)
    const capture = vi.spyOn(selection, 'collectSavedStructuredAgentSessionIds')
    const runtime = new AuthorityRuntime(profile.profile)
    expect(capture).toHaveBeenCalledOnce()
    expect(runtime.capturedSelection()).toEqual(ids)
    const rig = await openAuthorityRuntime(profile, runtime)
    const checks = { absent: 0, present: 0 }
    const has = state.hasAgentSessionConversation
    const checked = vi
      .spyOn(state, 'hasAgentSessionConversation')
      .mockImplementation((draft, id) => {
        checks[draft.sessionTabs === null ? 'absent' : 'present']++
        return has(draft, id)
      })
    const keyed = vi.spyOn(rig.store, 'isSessionTabVisible')
    const index = vi.spyOn(rig.store, 'getVisibleSessionTabIndex')
    const initialize = vi.spyOn(rig.store, 'initializeSessionTabs')
    const writer = vi.spyOn(rows, 'writeAgentSessionStoreRows')
    const opener = vi.spyOn(journalFactory, 'openAgentSessionJournal')
    const sink = vi.spyOn(rig.host.deps.statusSink!, 'publish')
    const turnWriter = vi.spyOn(rig.store, 'transitionHandoff')
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await chatTabCommandsSettled()
    expect(checks.absent).toBe(n)
    expect(checks.present).toBe(6 * n)
    expect(initialize).toHaveBeenCalledOnce()
    const batches = writer.mock.calls.filter(([, write]) => write.sessionTabs !== null)
    expect(batches).toHaveLength(1)
    expect(batches[0]![1].sessionTabs?.tabs).toHaveLength(n)
    expect(batches[0]![1].records.upsert).toEqual([])
    // Existing record-only lease reconciliation is separate from visibility materialization.
    expect(writer.mock.calls.filter(([, write]) => write.sessionTabs === null)).toHaveLength(1)
    expect(writer.mock.calls[0]![1].records.upsert).toHaveLength(n)
    expect(sink).toHaveBeenCalledTimes(n)
    expect(rig.host.listSessionTabs()).toHaveLength(n)
    expect(keyed.mock.calls.length).toBeLessThanOrEqual(10 * n)
    expect(index.mock.calls.length).toBeLessThanOrEqual(2)
    expect(opener).not.toHaveBeenCalled()
    expect(turnWriter).not.toHaveBeenCalled()
    expect(capture).toHaveBeenCalledOnce()
    const snapshot = rig.runtime.mobileSessionTabsByWorktree.get(rig.workspace)!
    const enumerate = vi.spyOn(snapshot.tabs, 'flatMap')
    for (const id of ids) {
      expect(rig.runtime.live(id)).toBe(true)
    }
    expect(enumerate).toHaveBeenCalledOnce()
    const replacement = rig.runtime.storeMobileSessionSnapshot(rig.workspace, {
      ...snapshot,
      tabs: [...snapshot.tabs]
    })
    const refreshed = vi.spyOn(replacement.tabs, 'flatMap')
    for (const id of ids) {
      expect(rig.runtime.live(id)).toBe(true)
    }
    expect(refreshed).toHaveBeenCalledOnce()
    rig.runtime.mobileSessionTabsByWorktree.delete(rig.workspace)
    for (const id of ids) {
      expect(rig.runtime.live(id)).toBe(false)
    }
    expect(refreshed).toHaveBeenCalledOnce()
    checked.mockClear()
    initialize.mockClear()
    writer.mockClear()
    await rig.store.setConversationName(ids[0]!, 'renamed')
    await rig.runtime.restoreStructuredAgentSessionTabs()
    expect(checked).not.toHaveBeenCalled()
    expect(initialize).not.toHaveBeenCalled()
    expect(writer.mock.calls.every(([, write]) => write.sessionTabs === null)).toBe(true)
    expect(capture).toHaveBeenCalledOnce()
  }
)

it.each([10, 100])(
  'prepare and actual direct/receipt stages rederive %i captured rows; metadata does not',
  async (n) => {
    const ids = Array.from({ length: n }, (_, i) => `selected-${i.toString().padStart(5, '0')}`)
    for (const first of [false, true]) {
      const profile = await authorityProfile(ids)
      const rig = await openAuthorityRuntime(profile)
      const checked = vi.spyOn(state, 'hasAgentSessionConversation')
      await rig.store.setConversationName(ids[0]!, 'metadata only')
      expect(checked).not.toHaveBeenCalled()
      const attempts: { checks: number; published: boolean; writes: number }[] = []
      const writer = vi.spyOn(rows, 'writeAgentSessionStoreRows')
      const commit = founding.commitAgentSessionFounding
      const attempt = vi
        .spyOn(founding, 'commitAgentSessionFounding')
        .mockImplementation((draft, request, base) => {
          const before = checked.mock.calls.length
          const result = commit(draft, request, base)
          attempts.push({
            checks: checked.mock.calls.length - before,
            published: rig.store.getVisibleSessionTabIndex().present,
            writes: writer.mock.calls.length
          })
          return result
        })
      expect(await createC(rig, first)).toMatchObject({ ok: true })
      expect(attempts).toEqual([
        { checks: 2 * n + 1, published: false, writes: 0 },
        { checks: 2 * n + 1, published: false, writes: 0 }
      ])
      expect(writer.mock.calls.filter(([, write]) => write.sessionTabs !== null)).toHaveLength(1)
      expect(rig.store.listVisibleSessionIds()).toEqual([...ids, 'chat-c-0003'])
      attempt.mockRestore()
      checked.mockRestore()
      writer.mockRestore()
      await stopStructuredAgentSessionRuntime()
      await closeTestStores()
      await closeTestJournalHostDatabases()
    }
  }
)

it.each([10, 100])(
  'present authority still pays one upfront %i-row capture and no further base traversal or init write',
  async (n) => {
    const ids = Array.from({ length: n }, (_, i) => `selected-${i.toString().padStart(5, '0')}`)
    const profile = await authorityProfile(ids, { visible: [] })
    const capture = vi.spyOn(selection, 'collectSavedStructuredAgentSessionIds')
    const runtime = new AuthorityRuntime(profile.profile)
    expect(runtime.capturedSelection()).toEqual(ids)
    const rig = await openAuthorityRuntime(profile, runtime)
    const has = state.hasAgentSessionConversation
    let legacyChecks = 0
    vi.spyOn(state, 'hasAgentSessionConversation').mockImplementation((draft, id) => {
      if (draft.sessionTabs === null) {
        legacyChecks++
      }
      return has(draft, id)
    })
    const initialize = vi.spyOn(rig.store, 'initializeSessionTabs')
    const writer = vi.spyOn(rows, 'writeAgentSessionStoreRows')
    await rig.runtime.restoreStructuredAgentSessionTabs()
    await rig.store.setConversationName(ids[0]!, 'metadata only')
    expect(capture).toHaveBeenCalledOnce()
    expect(legacyChecks).toBe(0)
    expect(initialize).not.toHaveBeenCalled()
    expect(writer.mock.calls.every(([, write]) => write.sessionTabs === null)).toBe(true)
    expect(rig.store.listVisibleSessionIds()).toEqual([])
  }
)

it.each(['receipt-first', 'ordinary-first'] as const)(
  'rebases first-message receipt against actual %s staging order',
  async (order) => {
    const rig = await openAuthorityRuntime(await authorityProfile())
    const stages: string[] = []
    let hide: Promise<void> | undefined
    if (order === 'ordinary-first') {
      await rig.store.setSessionTabVisibility(B, false, undefined, () => stages.push('ordinary'))
    }
    const receipt = rig.store.founding.receipt
    vi.spyOn(rig.store.founding, 'receipt').mockImplementation((request) => {
      const original = receipt(request)
      return {
        write: (...args) => {
          if (order === 'receipt-first') {
            hide = rig.store.setSessionTabVisibility(B, false, undefined, () =>
              stages.push('ordinary')
            )
          }
          stages.push('receipt')
          original.write(...args)
        },
        committed: original.committed
      }
    })
    expect(await createC(rig, true)).toMatchObject({ ok: true })
    await hide
    expect(stages).toEqual(
      order === 'receipt-first' ? ['receipt', 'ordinary'] : ['ordinary', 'receipt']
    )
    expect(rig.store.listVisibleSessionIds()).toEqual(['chat-c-0003'])
  }
)

const OLD = 'retired-project::/old/project'
/** A readable chat still placed at the old key, kept with its own saved tab. */
const RETAINED = 'retained-chat'
/** N moved chats, each now placed in its own current workspace, and N chats sharing one current
 *  workspace; all readable, visible and released before anything is measured. The old key keeps
 *  N retained groups: the retained chat with an editor beside it, then an editor in each other
 *  group, with order, selection and recent tabs, in one subtree of its split. With `hints`, the
 *  moved chats' saved tabs sit in the other subtree, one group each (every tenth twice). */
async function startupPopulation(n: number, hints: boolean) {
  const name = (kind: string, i: number) => `${kind}-${i.toString().padStart(5, '0')}`
  const moved = Array.from({ length: n }, (_, i) => name('moved', i))
  const shared = Array.from({ length: n }, (_, i) => name('shared', i))
  const visible = [...moved, ...shared, RETAINED]
  const input = await authorityProfile([], { records: visible, visible })
  const prior = await readPersistedTestAgentSessionStore(root)
  await seedTestAgentSessionRecordStore(root, {
    records: Object.values(prior.records).map((record) => {
      const index = moved.indexOf(record.sessionId)
      const workspaceId =
        record.sessionId === RETAINED
          ? OLD
          : index !== -1
            ? `current-${index}::/current/${index}`
            : 'shared::/current/shared'
      return {
        ...record,
        location: { ...record.location, workspaceId, workspaceKind: 'git-worktree' as const }
      }
    }),
    sessionTabs: visible.map((sessionId) => ({
      tabId: structuredAgentSessionTabId(sessionId),
      sessionId
    }))
  })
  const base = withChatTabChanges(
    'local',
    getDefaultWorkspaceSession(),
    OLD,
    [RETAINED, ...(hints ? moved : [])].map((sessionId) => ({
      open: { sessionId, agent: 'codex', tabId: structuredAgentSessionTabId(sessionId) }
    }))
  )!
  const rowOf = new Map((base.unifiedTabs?.[OLD] ?? []).map((row) => [row.entityId, row]))
  const chat = structuredAgentSessionTabId(RETAINED)
  const editor = (i: number) => `editor-${i}`
  const retained = Array.from({ length: n }, (_, i) => ({
    id: `retained-group-${i}`,
    worktreeId: OLD,
    activeTabId: editor(i),
    tabOrder: i === 0 ? [chat, editor(i)] : [editor(i)],
    recentTabIds: i === 0 ? [editor(i), chat] : [editor(i)]
  }))
  // Every tenth moved chat holds a second saved tab there too, after its first.
  const again = (tabId: string) => (twice.has(tabId) ? [tabId, `${tabId}-again`] : [tabId])
  const hinted = (hints ? moved : []).map((sessionId, i) => {
    const tabOrder = again(structuredAgentSessionTabId(sessionId))
    return { id: `moved-group-${i}`, worktreeId: OLD, activeTabId: tabOrder[0]!, tabOrder }
  })
  const template = rowOf.get(RETAINED)!
  const { agentSessionAgent: _agent, ...plain } = template
  const rows = [
    ...retained.flatMap((group, i) =>
      group.tabOrder.map((id, sortOrder) =>
        id === chat
          ? { ...template, groupId: group.id, sortOrder }
          : {
              ...plain,
              id,
              entityId: `/old/project/${editor(i)}.ts`,
              contentType: 'editor' as const,
              groupId: group.id,
              sortOrder
            }
      )
    ),
    ...hinted.flatMap((group, i) =>
      group.tabOrder.map((id, sortOrder) => ({
        ...rowOf.get(moved[i]!)!,
        id,
        groupId: group.id,
        sortOrder
      }))
    )
  ]
  const retainedTree = splitTree(retained.map((group) => group.id))!
  const movedTree = splitTree(hinted.map((group) => group.id))
  input.profile.setWorkspaceSession({
    ...base,
    unifiedTabs: { [OLD]: rows },
    tabGroups: { [OLD]: [...hinted, ...retained] },
    tabGroupLayouts: {
      [OLD]: movedTree
        ? { type: 'split', direction: 'horizontal', first: movedTree, second: retainedTree }
        : retainedTree
    },
    activeGroupIdByWorktree: { [OLD]: retained[0]!.id },
    activeTabIdByWorktree: { [OLD]: chat }
  })
  await input.profile.flushPendingOrThrowAsync()
  return { input, moved, shared, kept: { rows: rows.slice(0, n + 1), retained, retainedTree } }
}

/** A balanced split over the groups, in their order. */
function splitTree(groupIds: readonly string[]): TabGroupLayoutNode | undefined {
  if (groupIds.length <= 1) {
    return groupIds[0] ? { type: 'leaf', groupId: groupIds[0] } : undefined
  }
  const half = Math.ceil(groupIds.length / 2)
  return {
    type: 'split',
    direction: 'vertical',
    first: splitTree(groupIds.slice(0, half))!,
    second: splitTree(groupIds.slice(half))!,
    ratio: 0.5
  }
}

/** The old-key tabs of the moved chats, each tenth one's second tab right after its first. */
const twice = new Set(
  Array.from({ length: 20 }, (_, i) =>
    structuredAgentSessionTabId(`moved-${(i * 10).toString().padStart(5, '0')}`)
  )
)
const oldKeyCloses = (moved: readonly string[]) =>
  moved.flatMap((sessionId) => {
    const tabId = structuredAgentSessionTabId(sessionId)
    return (twice.has(tabId) ? [tabId, `${tabId}-again`] : [tabId]).map((id) => ({
      close: sessionId,
      tabId: id
    }))
  })

/** One real startup restore, settled, with the builder's own accumulation and each later phase
 *  counted. */
async function measuredStartup(n: number, hints: boolean, window: boolean, closing: boolean) {
  const { input, moved, shared, kept } = await startupPopulation(n, hints)
  const rig = await openAuthorityRuntime(input)
  if (window) {
    // Only the host's window availability seam; no app or window is launched.
    Object.defineProperty(rig.runtime, 'getAvailableAuthoritativeWindow', {
      value: () => ({
        id: 1,
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send: vi.fn() }
      })
    })
  }
  // Only while the real builder runs, and only for the map it returns: each bucket it writes and
  // how many earlier entries that bucket carried over.
  const writes: { map: Map<unknown, unknown>; carried: number }[] = []
  let building = false
  const set = Map.prototype.set
  const mapSet = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
    this: Map<unknown, unknown>,
    key: unknown,
    value: unknown
  ) {
    if (building && Array.isArray(value)) {
      writes.push({ map: this, carried: value.length - 1 })
    }
    return set.call(this, key, value)
  })
  const build = seed.chatTabChangesMatchingIndex
  const built: { result: Map<string, ChatTabChange[]>; unchanged: boolean }[] = []
  vi.spyOn(seed, 'chatTabChangesMatchingIndex').mockImplementation((saved, restored, retired) => {
    const before = JSON.stringify(saved)
    building = true
    try {
      const result = build(saved, restored, retired)
      built.push({ result, unchanged: JSON.stringify(saved) === before })
      return result
    } finally {
      building = false
      // The builder runs once; later phases' own map writes are not this spy's work.
      mapSet.mockRestore()
    }
  })
  // The old-key close command, run alone by the serial queue, and each derivation of an old-key
  // command (the close's, its admission's and the retained chat's open).
  let closingOld = false
  let derivingOld = false
  const derive = tabLayout.loadChatTabLayout
  vi.spyOn(tabLayout, 'loadChatTabLayout').mockImplementation((hostId, session, worktreeId) => {
    derivingOld = worktreeId === OLD
    try {
      return derive(hostId, session, worktreeId)
    } finally {
      derivingOld = false
    }
  })
  const closePhase = { loads: 0, loadedRows: 0, serializations: 0, serializedTabs: 0 }
  // Every whole-layout load and serialization (a load serializes once to normalize; an applied
  // command serializes its result), with the saved rows each was given. The serializer body
  // searches its ordered tabs once per tab (workspace-layout-save.ts:50-51), an unchanged main
  // cost: its visits are reported, not bounded here.
  const loads = { calls: 0, rows: 0, oldRows: 0 }
  const load = layoutLoad.loadWorkspaceLayout
  vi.spyOn(layoutLoad, 'loadWorkspaceLayout').mockImplementation((...args) => {
    loads.calls++
    loads.rows += Object.values(args[1].unifiedTabs ?? {}).flat().length
    loads.oldRows += args[1].unifiedTabs?.[OLD]?.length ?? 0
    if (closingOld || derivingOld) {
      closePhase.loads++
      closePhase.loadedRows += Object.values(args[1].unifiedTabs ?? {}).flat().length
    }
    return load(...args)
  })
  const serializations = { calls: 0, tabs: 0, oldTabs: 0, visits: 0 }
  const serialize = layoutSave.saveWorkspaceLayout
  vi.spyOn(layoutSave, 'saveWorkspaceLayout').mockImplementation((loaded) => {
    const { workspaces } = loaded.layout
    serializations.calls++
    serializations.tabs += Object.values(workspaces).reduce((sum, w) => sum + w.tabs.length, 0)
    serializations.oldTabs += workspaces[OLD]?.tabs.length ?? 0
    if (closingOld || derivingOld) {
      closePhase.serializations++
      closePhase.serializedTabs += Object.values(workspaces).reduce(
        (sum, w) => sum + w.tabs.length,
        0
      )
    }
    const serialized = collectionVisits(() => serialize(loaded))
    serializations.visits += serialized.visits
    return serialized.value
  })
  let closeWrites = 0
  const apply = rig.runtime.applyLayoutCommand.bind(rig.runtime)
  const commands = vi
    .spyOn(rig.runtime, 'applyLayoutCommand')
    .mockImplementation(async (command, run) => {
      closingOld = command.type === 'closeTabs' && command.workspace === OLD
      try {
        return await apply(command, run)
      } finally {
        closingOld = false
      }
    })
  // The old key's close, as the elements its holder lookup, command resolver and reducer visit,
  // the fields of its tree the reducer reads, the size of what the reducer was given, and the
  // workspace map keys it copies.
  const work = {
    holders: 0,
    resolver: 0,
    reducer: 0,
    reducerInput: 0,
    treeNodes: 0,
    treeReads: 0,
    rootCopies: 0,
    rootKeysCopied: 0
  }
  const counted =
    <A extends unknown[], R>(part: 'holders' | 'resolver' | 'reducer', run: (...args: A) => R) =>
    (...args: A): R => {
      const { value, visits } = collectionVisits(() => run(...args))
      work[part] += visits
      return value
    }
  const controller = RuntimeWorkspaceSessionController.prototype
  for (const name of ['getHostIdsForTab', 'getHostIdsForTabs'] as const) {
    const lookup = controller[name]
    // Absent only in the scalar build this measurement is checked against.
    if (lookup) {
      vi.spyOn(controller, name).mockImplementation(function (
        this: RuntimeWorkspaceSessionController,
        worktreeId: string,
        tabs: never
      ) {
        const call = () => lookup.call(this, worktreeId, tabs)
        return worktreeId === OLD ? counted('holders', call)() : call()
      } as never)
    }
  }
  const resolve = tabLayout.chatTabCloseCommand
  vi.spyOn(tabLayout, 'chatTabCloseCommand').mockImplementation((workspace, worktreeId, closes) =>
    worktreeId === OLD
      ? counted('resolver', resolve)(workspace, worktreeId, closes)
      : resolve(workspace, worktreeId, closes)
  )
  let reducing = false
  const close = tabCommands.closeTabs
  vi.spyOn(tabCommands, 'closeTabs').mockImplementation((model, command, context) => {
    if (command.workspace !== OLD) {
      return close(model, command, context)
    }
    // Tabs, groups, order and recent-tab references, and tree nodes, as the reducer gets them.
    const workspace = model.workspaces[OLD]
    const tree = fieldReads()
    const nodes = tree.watchTree(workspace?.groupLayout)
    work.treeNodes += nodes
    work.reducerInput +=
      nodes +
      (workspace?.tabs.length ?? 0) +
      (workspace?.groups ?? []).reduce((sum, group) => sum + 1 + group.tabOrder.length, 0)
    reducing = true
    try {
      return counted('reducer', close)(model, command, context)
    } finally {
      reducing = false
      work.treeReads += tree.reads()
      tree.restore()
    }
  })
  const copy = removal.withWorkspace
  vi.spyOn(removal, 'withWorkspace').mockImplementation((model, key, workspace) => {
    if (reducing) {
      work.rootCopies++
      work.rootKeysCopied += Object.keys(model.workspaces).length
    }
    return copy(model, key, workspace)
  })
  const saves = vi.spyOn(rig.profile, 'setWorkspaceSession')
  let durableWrites = 0
  for (const write of ['writeSerializedDomains', 'writeCompleteSerializedDomains'] as const) {
    const original = ProfileStateSqliteAuthority.prototype[write] as (
      replacements: readonly ProfileStateDomainReplacement[],
      ...rest: never[]
    ) => void
    vi.spyOn(ProfileStateSqliteAuthority.prototype, write).mockImplementation(function (
      this: ProfileStateSqliteAuthority,
      replacements: readonly ProfileStateDomainReplacement[],
      ...rest: never[]
    ) {
      durableWrites++
      closeWrites += closingOld ? 1 : 0
      return original.call(this, replacements, ...rest)
    })
  }
  let notified = 0
  let oldKeyNotices = 0
  rig.runtime.onMobileSessionTabsChanged((result) => {
    notified++
    oldKeyNotices += result.worktree === OLD ? 1 : 0
  })
  await rig.runtime.restoreStructuredAgentSessionTabs()
  await chatTabCommandsSettled()
  // Writes and notices settle before they are read.
  await rig.profile.flushPendingOrThrowAsync()
  rig.runtime['mobileSessionTabsNotifyCoalescer'].flushAll()
  expect(built).toHaveLength(1)
  const [{ result, unchanged }] = built
  expect(unchanged).toBe(true)
  const own = writes.filter((write) => write.map === result)
  const contributed = [...result.values()].reduce((sum, bucket) => sum + bucket.length, 0)
  const opened = (key: string) =>
    (result.get(key) ?? []).flatMap((change) => ('open' in change ? [change.open.sessionId] : []))
  // Both cohorts come out whole and in order: N shared opens, N single opens, N old-key closes.
  expect(opened('shared::/current/shared')).toEqual(shared)
  for (const [index, sessionId] of moved.entries()) {
    expect(opened(`current-${index}::/current/${index}`)).toEqual([sessionId])
  }
  // The retained chat's own open, then the moved chats' old-key closes.
  expect(opened(OLD)).toEqual([RETAINED])
  const oldCloses = hints && closing ? oldKeyCloses(moved) : []
  expect((result.get(OLD) ?? []).filter((change) => 'close' in change)).toEqual(oldCloses)
  expect(contributed).toBe(2 * n + 1 + oldCloses.length)
  const closes = commands.mock.calls.flatMap(([command]) =>
    command.type === 'closeTabs' && command.workspace === OLD ? [command.tabIds.length] : []
  )
  const saved = rig.profile.getWorkspaceSession('local')
  const savedOld = saved?.unifiedTabs?.[OLD] ?? []
  if (!window) {
    // Exactly the retained chat, editors, groups (order, selection, recent tabs) and their subtree.
    expect(savedOld.map((tab) => [tab.id, tab.groupId])).toEqual(
      kept.rows.map((tab) => [tab.id, tab.groupId])
    )
    expect(saved?.tabGroups?.[OLD]).toEqual(kept.retained)
    expect(saved?.tabGroupLayouts?.[OLD]).toEqual(kept.retainedTree)
  }
  const counts = {
    contributed,
    buckets: own.length,
    carried: own.reduce((sum, write) => sum + write.carried, 0),
    loads: loads.calls,
    loadedRows: loads.rows,
    loadedOldRows: loads.oldRows,
    serializations: serializations.calls,
    serializedTabs: serializations.tabs,
    serializedOldTabs: serializations.oldTabs,
    serializerVisits: serializations.visits,
    closeLoads: closePhase.loads,
    closeLoadedRows: closePhase.loadedRows,
    closeSerializations: closePhase.serializations,
    closeSerializedTabs: closePhase.serializedTabs,
    oldKeyCloseCommands: closes.length,
    oldKeyTabsClosedPerCommand: closes[0] ?? 0,
    savedMovedTabs: savedOld.filter((tab) => moved.includes(tab.entityId)).length,
    saves: saves.mock.calls.length,
    durableWrites,
    closeWrites,
    notified,
    oldKeyNotices,
    ...work
  }
  expect(counts.buckets).toBe(result.size)
  expect(counts.carried).toBe(0)
  await stopStructuredAgentSessionRuntime()
  await closeTestStores()
  await closeTestJournalHostDatabases()
  vi.restoreAllMocks()
  return counts
}

it.each([
  { mode: 'attached window', main: false, window: true },
  { mode: 'windowless', main: false, window: false },
  { mode: 'main-owned layout', main: true, window: false }
])(
  'startup builds the moved and shared cohorts in linear work at N and 10N ($mode)',
  async ({ mode, main, window }) => {
    layoutOwner.main = main
    // Windowless hosts drop the old hints before building; the other owners close them there.
    const closing = window || main
    const tally: Record<string, number[]> = {}
    for (const n of [20, 200]) {
      for (const hints of main ? [true, false] : [true]) {
        const counts = await measuredStartup(n, hints, window, closing)
        for (const [key, value] of Object.entries(counts)) {
          ;(tally[`${hints ? '' : 'withoutHints.'}${key}`] ??= []).push(value)
        }
      }
    }
    console.log('S2_STARTUP_COUNTS', JSON.stringify({ mode, tally }))
    expect(tally.contributed).toEqual(closing ? [63, 621] : [41, 401])
    expect(tally.carried).toEqual([0, 0])
    expect(tally.buckets![1]).toBeLessThanOrEqual(12 * tally.buckets![0]!)
    if (main) {
      // The moved cohort's closes are one command whatever N is, and add only a fixed number of
      // whole-layout loads, durable writes and old-key notices beside the same population without
      // hints; the opens' per-change saves, writes and notices are inherited and only reported.
      expect(tally.oldKeyCloseCommands).toEqual([1, 1])
      expect(tally.oldKeyTabsClosedPerCommand).toEqual([22, 220])
      expect(tally.savedMovedTabs).toEqual([0, 0])
      // The close writes once or twice itself; the old key's notices differ by a fixed count.
      expect(Math.max(...tally.closeWrites!)).toBeLessThanOrEqual(2)
      for (const key of ['loads', 'oldKeyNotices']) {
        const added = tally[key]!.map((value, i) => value - tally[`withoutHints.${key}`]![i]!)
        console.log('S2_CLOSE_ADDED', key, JSON.stringify(added))
        expect(added[1], key).toBe(added[0])
        expect(added[0], key).toBeLessThanOrEqual(4)
      }
      // Inside that command, each a fixed cost plus a few visits per element it is given: the
      // holder lookup over the old key's R saved rows for its T requested tabs, two resolutions
      // (the command and its admission) over the same, one reducer pass over its input (tabs,
      // groups, order references and tree nodes) reading each tree node a fixed number of times,
      // and one workspace-map copy. One lookup, close or tree removal per tab or emptied group
      // instead grows with N² and fails these.
      for (const [i, n] of [20, 200].entries()) {
        const requested = n + n / 10
        const rows = requested + n + 1
        expect(tally.holders![i], 'holders').toBeLessThanOrEqual(5 * (rows + requested) + 16)
        expect(tally.resolver![i], 'resolver').toBeLessThanOrEqual(10 * (rows + requested) + 16)
        expect(tally.reducer![i], 'reducer').toBeLessThanOrEqual(6 * tally.reducerInput![i]! + 32)
        expect(tally.treeReads![i], 'tree').toBeLessThanOrEqual(4 * tally.treeNodes![i]! + 16)
      }
      for (const part of ['holders', 'resolver', 'reducer', 'treeReads']) {
        expect(tally[part]![1]).toBeLessThanOrEqual(12 * tally[part]![0]!)
        expect(tally[`withoutHints.${part}`]).toEqual([0, 0])
      }
      // Whole-layout loads and serializations while deriving, admitting and applying the old-key
      // close: a fixed number of passes, each over the partition's rows at most (the old key's M
      // rows plus the 2N opened elsewhere), whatever the number of requested tabs or emptied
      // groups. The serializer's own per-tab search is main's and only reported.
      expect(tally.closeLoads![1]).toBe(tally.closeLoads![0])
      expect(tally.closeSerializations![1]).toBe(tally.closeSerializations![0])
      expect(tally.closeLoads![0]).toBeLessThanOrEqual(4)
      expect(tally.closeSerializations![0]).toBeLessThanOrEqual(6)
      for (const [i, n] of [20, 200].entries()) {
        const partitionRows = 2 * n + n / 10 + 1 + 2 * n
        expect(tally.closeLoadedRows![i]).toBeLessThanOrEqual(tally.closeLoads![i]! * partitionRows)
        expect(tally.closeSerializedTabs![i]).toBeLessThanOrEqual(
          tally.closeSerializations![i]! * partitionRows
        )
      }
      console.log('K18_SERIALIZER_VISITS_MAIN_COST', JSON.stringify(tally.serializerVisits))
      expect(tally.rootCopies).toEqual([1, 1])
      expect(tally.rootKeysCopied![1]).toBe(tally.rootKeysCopied![0])
    }
  },
  180_000
)
