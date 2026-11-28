import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalStopEvent } from '../../../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import { STOP_DECIDES_FAILURE_MS } from '../../../native-chat/agent-session-journal/context-epochs/journal-stop-turn-end'
import {
  errorRows,
  openStopJournal
} from '../../../native-chat/agent-session-journal/journal-stop-writer.test-fixture'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

// Codex's error rows for a failed turn, through the real translator into the real journal writer,
// against the Stop that writer saved: as the chat shows them.
const NOW = 1_800_000_000_000
const TURN = 'provider-turn'
const THREAD = 'thread-1'
const ERROR = { message: 'stream disconnected before completion' }
let journal: ReturnType<typeof openStopJournal> | null = null
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  journal?.close()
  journal = null
  vi.useRealTimers()
})

/** A running Codex turn. `deferred`: the writer resolves writes only when drained. */
function codexTurn(options: { deferred?: boolean; command?: true } = {}) {
  journal = openStopJournal({ deferred: options.deferred })
  const chat = journal
  const translator = createCodexJournalTranslator({
    sink: chat.sink,
    primaryThreadId: () => THREAD,
    sessionId: 'chat-1'
  })
  if (options.command) {
    // A compaction: its journal turn is the command's own, and a provider turn carries it.
    translator.beginCommand({
      clientMessageId: 'compact',
      turnId: 'command-turn',
      identity: { provider: 'orca', clientMessageId: 'command-turn-row' },
      resultIdentity: { provider: 'orca', clientMessageId: 'command-result' },
      running: { kind: 'turn', turnId: 'command-turn', state: 'running', startedAt: NOW - 60_000 }
    })
  }
  // `processedAt`: when the translator handles the frame, which a busy host makes later than its receipt.
  const send = (method: string, params: object, observedAt: number, processedAt = observedAt) => {
    vi.setSystemTime(processedAt)
    translator.handle({
      type: 'notification',
      sessionId: 'chat-1',
      threadId: THREAD,
      method,
      params: { threadId: THREAD, ...params },
      observedAt
    })
  }
  send('turn/started', { turn: { id: TURN } }, NOW - 60_000)
  chat.drain()
  return {
    stop: (reason: JournalStopEvent['reason'], turnId = options.command ? 'command-turn' : TURN) =>
      chat.stop(reason, NOW, turnId),
    notice: (at: number, processedAt?: number) =>
      send('error', { turnId: TURN, willRetry: false, error: ERROR }, at, processedAt),
    failed: (at: number) =>
      send('turn/completed', { turn: { id: TURN, status: 'failed', error: ERROR } }, at),
    drain: () => chat.drain(),
    errors: () => errorRows(chat.items()),
    outcome: () =>
      chat
        .items()
        .map((item) => readAgentJournalTurn(item.body))
        .find((turn) => turn?.turnId === TURN)?.outcome
  }
}

describe('a person stops a Codex turn that Codex then reports as failed', () => {
  it('shows no error row for the failed completion, and the turn reads stopped', () => {
    const turn = codexTurn()
    turn.stop('user-stop')
    turn.failed(NOW + 2_000)
    expect(turn.errors()).toEqual([])
    expect(turn.outcome()).toBe('cancellation')
  })

  it('shows none for its error notice and completion', () => {
    const turn = codexTurn()
    turn.stop('user-stop')
    turn.notice(NOW + 1_000)
    turn.failed(NOW + 1_500)
    expect(turn.errors()).toEqual([])
  })

  it('shows none when the person closed the chat on it', () => {
    const turn = codexTurn()
    turn.stop('user-close')
    turn.failed(NOW + 1_000)
    expect(turn.errors()).toEqual([])
  })

  it('judges the row by when Codex sent it, not when Orca got to it', () => {
    const turn = codexTurn()
    turn.stop('user-stop')
    turn.notice(NOW + STOP_DECIDES_FAILURE_MS - 1_000, NOW + STOP_DECIDES_FAILURE_MS + 10_000)
    expect(turn.errors()).toEqual([])
  })

  it('drops it at the Stop itself and at the window’s far edge', () => {
    for (const at of [NOW, NOW + STOP_DECIDES_FAILURE_MS]) {
      const turn = codexTurn()
      turn.stop('user-stop')
      turn.notice(at)
      expect(turn.errors()).toEqual([])
      journal?.close()
      journal = null
    }
  })

  it('shows none for a stopped command turn', () => {
    const turn = codexTurn({ command: true })
    turn.stop('user-stop')
    turn.notice(NOW + 2_000)
    expect(turn.errors()).toEqual([])
  })

  it('waits on the writer, then shows none when the completion is in the window too', () => {
    const turn = codexTurn({ deferred: true })
    turn.stop('user-stop')
    turn.notice(NOW + 29_000)
    turn.failed(NOW + 29_500)
    turn.drain()
    expect(turn.errors()).toEqual([])
  })
})

describe('a real Codex failure keeps exactly one error row', () => {
  it('with no Stop, notice and completion alike', () => {
    for (const deferred of [false, true]) {
      const turn = codexTurn({ deferred })
      turn.notice(NOW)
      turn.failed(NOW + 500)
      turn.drain()
      expect(turn.errors()).toHaveLength(1)
      expect(turn.outcome()).toBe('failure')
      journal?.close()
      journal = null
    }
  })

  it('one millisecond past the window', () => {
    const turn = codexTurn()
    turn.stop('user-stop')
    turn.notice(NOW + STOP_DECIDES_FAILURE_MS + 1)
    expect(turn.errors()).toHaveLength(1)
  })

  it('when its completion fails past the window after a notice the Stop dropped', () => {
    for (const deferred of [false, true]) {
      const turn = codexTurn({ deferred })
      turn.stop('user-stop')
      turn.notice(NOW + 29_000)
      turn.failed(NOW + 31_000)
      turn.drain()
      expect(turn.errors()).toHaveLength(1)
      expect(turn.outcome()).toBe('failure')
      journal?.close()
      journal = null
    }
  })

  it('when it failed before the Stop, even though the turn then reads stopped', () => {
    // The notice is a real error from before the Stop, so its row stays.
    const turn = codexTurn()
    turn.notice(NOW - 1_000)
    turn.stop('user-stop')
    turn.failed(NOW + 2_000)
    expect(turn.errors()).toHaveLength(1)
    expect(turn.outcome()).toBe('cancellation')
  })

  it('when the Stop was for another turn', () => {
    const turn = codexTurn()
    turn.stop('user-stop', 'earlier-turn')
    turn.failed(NOW + 1_000)
    expect(turn.errors()).toHaveLength(1)
  })

  it('when Orca, not a person, stopped it', () => {
    for (const reason of ['host-stop', 'evict', 'context-clear'] as const) {
      const turn = codexTurn()
      turn.stop(reason)
      turn.failed(NOW + 1_000)
      expect(turn.errors()).toHaveLength(1)
      journal?.close()
      journal = null
    }
  })
})
