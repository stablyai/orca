import { expect, it, vi } from 'vitest'
import {
  AuthorityRuntime,
  authorityProfile,
  openAuthorityRuntime,
  createC,
  B
} from './structured-agent-session-tab-authority.test-support'
import * as selection from './saved-structured-agent-session-restoration'
import * as founding from './agent-session-founding-admission'
import * as state from './agent-session-store-state'
import * as rows from './agent-session-record-rows'
import * as journalFactory from '../native-chat/agent-session-journal/journal-store-factory'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import { closeTestStores } from '../persistence/persistence-test-harness'
import { closeTestJournalHostDatabases } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { chatTabCommandsSettled } from './session-layout-apply.test-fixture'

// CLI capability probing is outside tab authority and must not start a real CLI in this fixture.
vi.mock('../claude/claude-cli-flag-prewarm', () => ({
  prewarmClaudeCliFlags: async () => undefined
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
      closeTestJournalHostDatabases()
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
