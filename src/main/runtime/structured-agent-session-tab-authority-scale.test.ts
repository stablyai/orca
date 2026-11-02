import { expect, it, vi } from 'vitest'
import {
  AuthorityRuntime,
  authorityProfile,
  openAuthorityRuntime,
  createC,
  B
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
import { root } from './structured-agent-session-tab-authority.test-support'
import {
  readPersistedTestAgentSessionStore,
  seedTestAgentSessionRecordStore
} from './agent-session/records/agent-session-record-store-test-harness'
import * as seed from './agent-session/structured-agent-session-tab-index-seed'
import * as layoutLoad from '../../shared/workspace-layout/workspace-layout-load'
import { withChatTabChanges, type ChatTabChange } from './agent-session/agent-session-tab-layout'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { structuredAgentSessionTabId } from '../../shared/agent-session/view/structured-agent-session-projection'

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
/** N moved chats, each now placed in its own current workspace with its saved hint (unless
 *  `hints` is off) under one old key, and N chats sharing one current workspace; all readable,
 *  visible and released before anything is measured. */
async function startupPopulation(n: number, hints: boolean) {
  const name = (kind: string, i: number) => `${kind}-${i.toString().padStart(5, '0')}`
  const moved = Array.from({ length: n }, (_, i) => name('moved', i))
  const shared = Array.from({ length: n }, (_, i) => name('shared', i))
  const visible = [...moved, ...shared]
  const input = await authorityProfile([], { records: visible, visible })
  const prior = await readPersistedTestAgentSessionStore(root)
  await seedTestAgentSessionRecordStore(root, {
    records: Object.values(prior.records).map((record) => {
      const index = moved.indexOf(record.sessionId)
      const workspaceId =
        index !== -1 ? `current-${index}::/current/${index}` : 'shared::/current/shared'
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
  if (hints) {
    input.profile.setWorkspaceSession(
      withChatTabChanges(
        'local',
        getDefaultWorkspaceSession(),
        OLD,
        moved.map((sessionId) => ({
          open: { sessionId, agent: 'codex', tabId: structuredAgentSessionTabId(sessionId) }
        }))
      )!
    )
  }
  await input.profile.flushPendingOrThrowAsync()
  return { input, moved, shared }
}

/** One real startup restore, settled, with the builder's own accumulation and each later phase
 *  counted. */
async function measuredStartup(n: number, hints: boolean, window: boolean, closing: boolean) {
  const { input, moved, shared } = await startupPopulation(n, hints)
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
  vi.spyOn(Map.prototype, 'set').mockImplementation(function (
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
    }
  })
  const loads = { calls: 0, rows: 0 }
  const load = layoutLoad.loadWorkspaceLayout
  vi.spyOn(layoutLoad, 'loadWorkspaceLayout').mockImplementation((...args) => {
    loads.calls++
    loads.rows += Object.values(args[1].unifiedTabs ?? {}).flat().length
    return load(...args)
  })
  const commands = vi.spyOn(rig.runtime, 'applyLayoutCommand')
  const saves = vi.spyOn(rig.profile, 'setWorkspaceSession')
  let notified = 0
  rig.runtime.onMobileSessionTabsChanged(() => notified++)
  await rig.runtime.restoreStructuredAgentSessionTabs()
  await chatTabCommandsSettled()
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
  expect(result.get(OLD) ?? []).toEqual(
    hints && closing
      ? moved.map((sessionId) => ({
          close: sessionId,
          tabId: structuredAgentSessionTabId(sessionId)
        }))
      : []
  )
  expect(contributed).toBe(hints && closing ? 3 * n : 2 * n)
  const closes = commands.mock.calls.flatMap(([command]) =>
    command.type === 'closeTabs' && command.workspace === OLD ? [command.tabIds.length] : []
  )
  const savedOld = rig.profile.getWorkspaceSession('local')?.unifiedTabs?.[OLD] ?? []
  const counts = {
    contributed,
    buckets: own.length,
    carried: own.reduce((sum, write) => sum + write.carried, 0),
    loads: loads.calls,
    loadedRows: loads.rows,
    oldKeyCloseCommands: closes.length,
    oldKeyTabsClosedPerCommand: closes[0] ?? 0,
    savedOldKeyTabs: savedOld.length,
    saves: saves.mock.calls.length,
    notified
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
    expect(tally.contributed).toEqual(closing ? [60, 600] : [40, 400])
    expect(tally.carried).toEqual([0, 0])
    expect(tally.buckets![1]).toBeLessThanOrEqual(12 * tally.buckets![0]!)
    if (main) {
      // The moved cohort's closes are one command whatever N is, and add only a fixed number of
      // whole-layout loads; the opens' per-change layout work is inherited and reported only.
      expect(tally.oldKeyCloseCommands).toEqual([1, 1])
      expect(tally.oldKeyTabsClosedPerCommand).toEqual([20, 200])
      expect(tally.savedOldKeyTabs).toEqual([0, 0])
      const added = tally.loads!.map((value, i) => value - tally['withoutHints.loads']![i]!)
      expect(added[1]).toBe(added[0])
      expect(added[0]).toBeLessThanOrEqual(4)
    }
  },
  180_000
)
