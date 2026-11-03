import { expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { selectStructuredAgentTurnBars } from '../../../shared/agent-session/view/structured-agent-session-turn-timing'
import { formatNativeChatTurnStatusLabel } from '../../../shared/native-chat/transcript/native-chat-turn-status'
import type { AgentSessionTurnCompletionEvent } from '../../../shared/agent-session/view/agent-session-turn-completion-wire'
import { claudeFrame as frame } from '../../claude/structured/claude-structured-session-test-support'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data'
import {
  fixture,
  INTERRUPTED_RESULT,
  laneDrained
} from './structured-agent-session-claude-stop-contract-test-fixture'
import {
  dispatch,
  eventually,
  send,
  sendUnechoed,
  stop
} from './structured-agent-session-claude-stop-contract-test-actions'

async function snapshot() {
  await laneDrained()
  await fixture.host.flushStreamedEvents(SESSION)
  return fixture.host.journalSnapshot(SESSION)
}

// Constructed remints around the captured startup/compaction order; no new CLI capture is claimed.
it.each(['complete', 'stop'])(
  'keeps the canonical pre-echo owner through joined remints and %s',
  async (ending) => {
    const connection = fixture.claude.connections[0]!
    const completions: AgentSessionTurnCompletionEvent[] = []
    fixture.host.subscribeTurnCompletions({
      id: 'reminted-echo',
      emit: (event) => completions.push(event)
    })
    const acceptedPublications = new Set<string>()
    fixture.host.observeJournalPublications(SESSION, (journal) => {
      const current = journal.snapshot()
      for (const submission of current.submissions) {
        if (submission.dispatchState === 'accepted' && submission.providerItemId) {
          expect(
            current.items.some(
              (item) => item.itemId === journal.canonicalItemId(submission.providerItemId!)
            )
          ).toBe(true)
          acceptedPublications.add(submission.clientMessageId)
        }
      }
      expect(
        current.items.some((item) => readAgentJournalTurn(item.body)?.outcome === 'superseded')
      ).toBe(false)
    })
    const first = await sendUnechoed(connection)
    const written = connection.sent[0]!
    frame(connection, { type: 'command_lifecycle', state: 'started', command_uuid: written.uuid })
    frame(connection, {
      type: 'system',
      subtype: 'status',
      status: 'compacting',
      uuid: 'canonical-a'
    })
    const opened = (await snapshot()).items.find((item) => item.body.kind === 'turn')!
    expect(readAgentJournalTurn(opened.body)).toMatchObject({
      turnId: 'canonical-a',
      state: 'running',
      userItemId: agentJournalSubmissionKey(first)
    })

    const second = await send('Continue with this distinct follow-up.')
    await eventually(() => expect(connection.sent).toHaveLength(2))
    const secondWritten = connection.sent[1]!
    frame(connection, { type: 'system', subtype: 'status', status: null, uuid: 'compaction-ended' })
    frame(connection, { ...written, uuid: 'reminted-a', parent_tool_use_id: null })
    frame(connection, { ...secondWritten, uuid: 'reminted-b', parent_tool_use_id: null })
    frame(connection, {
      type: 'assistant',
      uuid: 'continuing-output',
      parent_tool_use_id: null,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Still the same reply.' }] }
    })

    const working = await snapshot()
    expect(working.items.filter((item) => item.body.kind === 'turn')).toEqual([opened])
    expect(
      working.items.find((item) => item.body.kind === 'message' && item.body.role === 'assistant')
        ?.turnScope
    ).toEqual({ kind: 'turn', turnItemId: opened.itemId })
    expect(await dispatch(first)).toMatchObject({ state: 'accepted' })
    expect(await dispatch(second)).toMatchObject({ state: 'accepted' })
    for (const [clientMessageId, uuid] of [
      [first, 'reminted-a'],
      [second, 'reminted-b']
    ]) {
      expect(
        working.submissions.find((entry) => entry.clientMessageId === clientMessageId)
          ?.providerItemId
      ).toContain(uuid)
    }
    expect(acceptedPublications).toEqual(new Set([first, second]))
    expect(completions).toEqual([])
    const bars = selectStructuredAgentTurnBars(working.items, working.submissions, 'canonical-a')
    expect(bars.runningTiming).toMatchObject({
      state: 'running',
      startedAt: readAgentJournalTurn(opened.body)?.startedAt
    })
    expect([...bars.settledTurns.values()].every((timing) => timing === null)).toBe(true)

    if (ending === 'stop') {
      fixture.claude.routes.interrupt = () => {
        frame(connection, INTERRUPTED_RESULT)
        return { still_queued: [], cancelled: [] }
      }
      await expect(stop('canonical-a')).resolves.toMatchObject({
        ok: true,
        value: { cancelled: true }
      })
    } else {
      frame(connection, {
        type: 'result',
        subtype: 'success',
        is_error: false,
        uuid: 'actual-result',
        duration_ms: 2_000
      })
    }
    const finished = await snapshot()
    const turns = finished.items.flatMap((item) => {
      const turn = readAgentJournalTurn(item.body)
      return turn ? [turn] : []
    })
    expect(turns).toEqual([
      expect.objectContaining({
        turnId: 'canonical-a',
        state: ending === 'stop' ? 'interrupted' : 'completed',
        outcome: ending === 'stop' ? 'cancellation' : 'success'
      })
    ])
    expect(completions.filter((event) => event.type === 'completion')).toEqual([
      expect.objectContaining({
        completion: expect.objectContaining({
          turnId: 'canonical-a',
          outcome: ending === 'stop' ? 'cancellation' : 'success'
        })
      })
    ])
    expect(
      formatNativeChatTurnStatusLabel({
        workedSeconds: 2,
        elapsedSeconds: 2,
        verdict: turns[0]!.outcome
      })
    ).toMatch(ending === 'stop' ? /^Interrupted/ : /^Worked/)
  }
)
