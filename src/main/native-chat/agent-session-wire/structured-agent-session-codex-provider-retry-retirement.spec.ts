import { CodexAppServerTimeoutError } from '../../codex/codex-app-server-session'
import { expect, it, vi } from 'vitest'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import { THREAD_ID as THREAD } from '../../codex/codex-structured-session-adapter-fixture'
import { structuredAgentSessionProviderRetryPending } from './structured-agent-session-provider-retry'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { codexTurnLifecycleIdentity } from '../../codex/codex-structured-journal-translation-turns'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { tearDownRuntime } from '../../runtime/agent-session/structured-agent-session-runtime-teardown'
import {
  CALLER,
  FAILURE,
  journalOf,
  hidden,
  clock,
  flush,
  fail,
  root,
  startHidden
} from './structured-agent-session-codex-provider-retry-test-support'
import type { Rig } from './structured-agent-session-codex-provider-retry-test-support'

export function registerCodexRetryRetirement(get: () => Rig): void {
  it('does not turn a real compact command terminal into automatic personal work', async () => {
    const rig = get()
    await root(rig)
    rig.turns.end('completed')
    await flush(rig)
    clock()
    rig.codex.routes['thread/compact/start'] = () => {
      rig.notify('turn/started', { threadId: THREAD, turn: { id: 'compact-turn' } })
      rig.notify('turn/completed', {
        threadId: THREAD,
        turn: {
          id: 'compact-turn',
          status: 'failed',
          error: { message: FAILURE, codexErrorInfo: 'serverOverloaded' }
        }
      })
      return {}
    }
    const fields = { command: 'compact' as const }
    expect(
      await rig.host.conversationCommand(CALLER, {
        envelope: rig.envelope('agentSession.conversationCommand', fields),
        ...fields
      })
    ).toMatchObject({ ok: true })
    await flush(rig)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(hidden(rig)).toHaveLength(0)
    expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
  })

  it('does not let a typed child-thread terminal settle or continue the accepted root', async () => {
    const rig = get()
    await root(rig)
    clock()
    rig.notify('turn/started', { threadId: 'child-thread', turn: { id: 'child-turn' } })
    rig.notify('turn/completed', {
      threadId: 'child-thread',
      turn: {
        id: 'child-turn',
        status: 'failed',
        error: { message: FAILURE, codexErrorInfo: 'serverOverloaded' }
      }
    })
    await flush(rig)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(hidden(rig)).toHaveLength(0)
    expect(rig.host.currentWork(SESSION)?.activeTurnId()).toBe(rig.turns.turnId)
    rig.turns.end('completed')
    await flush(rig)
  })

  it('terminates an uncertain hidden write without resend or resurrection from a late open/terminal', async () => {
    const rig = get()
    await root(rig)
    clock()
    await fail(rig)
    rig.codex.routes['turn/start'] = () => {
      throw new CodexAppServerTimeoutError('written request lost its reply')
    }
    await vi.advanceTimersByTimeAsync(2_000)
    await flush(rig)
    expect(hidden(rig)).toHaveLength(1)
    expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
    rig.notify('turn/started', {
      threadId: THREAD,
      turn: { id: 'late-unknown', status: 'inProgress' }
    })
    rig.notify('turn/completed', {
      threadId: THREAD,
      turn: {
        id: 'late-unknown',
        status: 'failed',
        error: { message: FAILURE, codexErrorInfo: 'serverOverloaded' }
      }
    })
    await flush(rig)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(hidden(rig)).toHaveLength(1)
  })

  it.each([1_024, 1_023])(
    'keeps typed terminal evidence coherent through real queue pressure with %i occupied slots',
    async (occupied) => {
      const rig = get()
      await root(rig)
      clock()
      const turnId = rig.turns.turnId!
      rig.notify('error', {
        threadId: THREAD,
        turnId,
        willRetry: true,
        error: { message: FAILURE, codexErrorInfo: 'responseStreamDisconnected' }
      })
      await flush(rig)
      const runtime = rig.host.collaboratorsForTests().runtimeState
      const deferred = runtime.currentEventSink(SESSION)!
      const journal = journalOf(rig)
      deferred.unbind()
      for (let index = 0; index < occupied; index++) {
        expect(
          deferred.sink.tryAppendItem?.(
            { provider: 'legacy', agent: 'codex', sessionId: SESSION, recordId: 'pressure' },
            { kind: 'status', text: `pressure-${index}` },
            { lifecycle: true, turnScope: { kind: 'thread' } }
          )
        ).toEqual({ accepted: true })
      }
      rig.turns.end('failed', FAILURE, 'other')
      expect(hidden(rig)).toHaveLength(0)
      expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
      deferred.bind({
        journal,
        fence: rig.conversationFence(),
        publish: () => rig.host['subscribers'].publish(SESSION, journal)
      })
      await deferred.drained()
      await vi.advanceTimersByTimeAsync(25)
      await flush(rig)
      expect(structuredAgentSessionProviderRetryPending(journal)).toBe(true)
      // Replay/duplicate of a terminal whose write was already admitted cannot reset its ordinal.
      rig.notify('turn/completed', {
        threadId: THREAD,
        turn: { id: turnId, status: 'failed', error: { message: FAILURE, codexErrorInfo: 'other' } }
      })
      await flush(rig)
      await startHidden(rig, 2_000, 1)
      rig.turns.end('completed')
      await flush(rig)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(1)
    }
  )

  it('discards staged typed evidence when the actual terminal transaction fails', async () => {
    const rig = get()
    await root(rig)
    clock()
    const journal = journalOf(rig)
    const runtime = rig.host.collaboratorsForTests().runtimeState
    const write = vi.spyOn(journal['database'], 'transaction').mockImplementationOnce(() => {
      throw new Error('terminal disk write failed')
    })
    try {
      rig.turns.end('failed', FAILURE, 'serverOverloaded')
      await expect(flush(rig)).rejects.toThrow('terminal disk write failed')
      expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(0)
    } finally {
      write.mockRestore()
      // The permanently failed sink cannot be drained again during fixture cleanup.
      runtime.discardEventSink(SESSION)
    }
  })

  it('publishes successful option retirement with no further provider row and preserves rejected options', async () => {
    const rig = get()
    await root(rig)
    clock()
    await fail(rig)
    const before = journalOf(rig).cursor()
    const statuses: string[] = []
    const unsubscribe = rig.host.observeJournalPublications(SESSION, () =>
      statuses.push(rig.host.readStatusSummary(SESSION)?.status ?? 'missing')
    )
    try {
      const fields = { key: 'not-an-option', value: 'invalid' }
      expect(
        await rig.host.setOption(CALLER, {
          envelope: rig.envelope('agentSession.setOption', fields),
          ...fields
        })
      ).toMatchObject({ ok: false })
      expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(true)
      expect(rig.failures).toHaveLength(0)
      await rig.pick('ask')
      expect(journalOf(rig).cursor()).toEqual(before)
      expect(rig.host.readStatusSummary(SESSION)).toMatchObject({
        status: 'idle',
        turnOutcome: 'failure'
      })
      expect(statuses.at(-1)).toBe('idle')
      expect(rig.failures).toHaveLength(0)
      expect(
        rig.host['clientDelivery'].requestFailures['baselines'].get(SESSION)?.deferred
      ).toBeUndefined()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(hidden(rig)).toHaveLength(0)
    } finally {
      unsubscribe()
    }
  })

  it('real runtime teardown permanently ends delivery before a held recovery and still drains late terminal evidence', async () => {
    const rig = get()
    await root(rig)
    clock()
    const held = Promise.withResolvers<void>()
    const tearingDown = tearDownRuntime(
      {
        host: rig.host,
        adapter: rig.adapter,
        journalDatabase: rig.host['deps'].journalDatabase,
        waitForRecovery: () => held.promise
      },
      'quit'
    )
    expect(rig.host.collaboratorsForTests().conversationDelivery.loop.isDisposed()).toBe(true)
    await fail(rig)
    expect(
      journalOf(rig)
        .snapshot()
        .items.some((item) => readAgentJournalTurn(item.body)?.outcome === 'failure')
    ).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(hidden(rig)).toHaveLength(0)
    expect(structuredAgentSessionProviderRetryPending(journalOf(rig))).toBe(false)
    expect(rig.failures).toHaveLength(0)
    expect(rig.host['providerRetry']['retries'].size).toBe(0)
    expect(rig.host['clientDelivery'].requestFailures['baselines'].size).toBe(0)
    held.resolve()
    await vi.advanceTimersByTimeAsync(20)
    await tearingDown
  })

  it.each([false, true])(
    'reopens saved failed history with stopped=%s, no retry execution, then accepts two normal replies',
    async (stopped) => {
      const rig = get()
      await root(rig)
      const turnId = rig.turns.turnId!
      clock()
      await fail(rig)
      if (stopped) {
        await rig.stop()
      }
      const key = agentJournalItemKey(codexTurnLifecycleIdentity(SESSION, turnId))
      const before = journalOf(rig).item(key)!
      const restarted = await rig.restartHost()
      const journal = restarted.collaboratorsForTests().sessions.get(SESSION)!.journal
      expect(journal.itemBody(key)).toMatchObject({ outcome: stopped ? 'cancellation' : 'failure' })
      expect(journal.item(key)?.sequence).toBe(before.sequence)
      expect(structuredAgentSessionProviderRetryPending(journal)).toBe(false)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(hidden(rig)).toHaveLength(0)
      for (const text of ['first normal reply', 'second normal reply']) {
        const id = await rig.permissionSend(text)
        await rig.began(id)
        rig.turns.end('completed')
        await restarted.flushStreamedEvents(SESSION)
        expect(restarted.readStatusSummary(SESSION)).toMatchObject({
          status: 'idle',
          turnOutcome: 'success'
        })
      }
      expect(hidden(rig)).toHaveLength(0)
    }
  )
}
