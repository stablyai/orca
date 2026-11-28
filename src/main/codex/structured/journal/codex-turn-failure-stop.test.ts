import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { JournalStopEvent } from '../../../native-chat/agent-session-journal/durable-rows/journal-row-schema'
import {
  errorRows,
  openStopJournal
} from '../../../native-chat/agent-session-journal/journal-stop-writer.test-fixture'
import { codexAcquisitionNotificationHandler } from '../acquisition/codex-structured-acquisition-notification'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

// Codex's error rows for a failed turn, as the chat shows them: each frame enters through the real
// notification handler, which stamps its receipt, then the real translator and the real journal
// writer, against the Stop that writer saved.
const NOW = 1_800_000_000_000
// The Stop's window, written out: the production constant doesn't exist before the fix.
const WINDOW_MS = 30_000
const TURN = 'provider-turn'
const THREAD = 'thread-1'
const ERROR = { message: 'stream disconnected before completion' }
const TERMINAL_ROW = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: `terminal-failure:codex:${JSON.stringify([THREAD, TURN])}`
})
let journal: ReturnType<typeof openStopJournal> | null = null
beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  journal?.close()
  journal = null
  vi.useRealTimers()
})

/** A running Codex turn. `deferred`: the writer resolves writes only when drained. */
function codexTurn(options: { deferred?: boolean; command?: true } = {}) {
  journal?.close()
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
  let receivedAt = NOW
  const delivered: (() => unknown)[] = []
  const receive = codexAcquisitionNotificationHandler({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these frames read no acquisition settings.
    acquisition: {} as never,
    sessionId: 'chat-1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only these two members.
    dispatchEchoes: { latestSequence: () => 0, observeStatus: () => {} } as never,
    primaryThreadId: () => THREAD,
    notificationRetries: {
      handle: (sessionId: string, method: string, params: unknown, observedAt?: number) =>
        translator.handle({
          type: 'notification',
          sessionId,
          threadId: THREAD,
          method,
          params,
          ...(observedAt === undefined ? {} : { observedAt })
        })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler calls only handle.
    } as never,
    deliver: (_acquisition, _sessionId, event) => {
      delivered.push(event)
    },
    now: () => receivedAt
  })
  // Received at `at`; the translator gets to it at `processedAt`, which a busy host makes later.
  const send = (method: string, params: object, at: number, processedAt = at) => {
    receivedAt = at
    receive(method, { threadId: THREAD, ...params })
    vi.setSystemTime(processedAt)
    return delivered.splice(0).map((event) => event())
  }
  send('turn/started', { turn: { id: TURN } }, NOW - 60_000)
  chat.drain()
  const stopTurn = options.command ? 'command-turn' : TURN
  return {
    stop: (reason: JournalStopEvent['reason'], turnId = stopTurn) => chat.stop(reason, NOW, turnId),
    notice: (at: number, processedAt?: number) =>
      send('error', { turnId: TURN, willRetry: false, error: ERROR }, at, processedAt),
    failed: (at: number, turn: object = { id: TURN }) =>
      send('turn/completed', { turn: { ...turn, status: 'failed', error: ERROR } }, at),
    completed: (at: number) =>
      send('turn/completed', { turn: { id: TURN, status: 'completed' } }, at),
    reject: chat.reject,
    drain: () => chat.drain(),
    errors: () => errorRows(chat.items()),
    outcome: (turnId = stopTurn) =>
      chat
        .items()
        .map((item) => readAgentJournalTurn(item.body))
        .find((turn) => turn?.turnId === turnId)?.outcome
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

  it('shows none for its error notice and completion, on either writer', () => {
    for (const deferred of [false, true]) {
      const turn = codexTurn({ deferred })
      turn.stop('user-stop')
      turn.notice(NOW + 29_000)
      turn.failed(NOW + 29_500)
      turn.drain()
      expect(turn.errors()).toEqual([])
    }
  })

  it('shows none when the person closed the chat on it', () => {
    const turn = codexTurn()
    turn.stop('user-close')
    turn.failed(NOW + 1_000)
    expect(turn.errors()).toEqual([])
  })

  it('judges the error notice by when the handler received it, not when Orca got to it', () => {
    const turn = codexTurn()
    turn.stop('user-stop')
    turn.notice(NOW + WINDOW_MS - 1_000, NOW + WINDOW_MS + 10_000)
    expect(turn.errors()).toEqual([])
  })

  it('drops it at the Stop itself and at the window’s far edge', () => {
    for (const at of [NOW, NOW + WINDOW_MS]) {
      const turn = codexTurn()
      turn.stop('user-stop')
      turn.notice(at)
      expect(turn.errors()).toEqual([])
    }
  })

  it('shows none for a stopped command turn, on either writer', () => {
    for (const deferred of [false, true]) {
      const turn = codexTurn({ deferred, command: true })
      turn.stop('user-stop')
      turn.notice(NOW + 2_000)
      turn.failed(NOW + 2_500)
      turn.drain()
      expect(turn.errors()).toEqual([])
    }
  })

  it('shows no failure row for a stopped compaction Codex ended without a marker', () => {
    const turn = codexTurn({ command: true })
    turn.stop('user-stop')
    turn.completed(NOW + 2_000)
    expect(turn.errors()).toEqual([])
    expect(turn.outcome()).toBe('cancellation')
  })
})

describe('a real Codex failure keeps exactly one error row', () => {
  it('with no Stop, notice and completion alike, on either writer', () => {
    for (const deferred of [false, true]) {
      const turn = codexTurn({ deferred })
      turn.notice(NOW)
      turn.failed(NOW + 500)
      turn.drain()
      expect(turn.errors()).toHaveLength(1)
      expect(turn.outcome()).toBe('failure')
    }
  })

  it('one millisecond past the window', () => {
    const turn = codexTurn()
    turn.stop('user-stop')
    turn.notice(NOW + WINDOW_MS + 1)
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
    }
  })

  it('when that completion names no turn and the writer resolves it after the turn ended', () => {
    const turn = codexTurn({ deferred: true })
    turn.stop('user-stop')
    turn.notice(NOW + 29_000)
    turn.failed(NOW + 31_000, {})
    turn.drain()
    // The turn's own terminal row, in the turn: what the frame named when it arrived.
    expect(turn.errors().map((row) => [row.itemId, row.turnScope?.kind])).toEqual([
      [TERMINAL_ROW, 'turn']
    ])
  })

  it('when it failed before the Stop, even though the turn then reads stopped', () => {
    // The error notice came before the Stop, so it is a real error and its row stays.
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
    }
  })

  it('for a stopped compaction whose error notice the Stop dropped, ended without a marker later', () => {
    for (const deferred of [false, true]) {
      const turn = codexTurn({ deferred, command: true })
      turn.stop('user-stop')
      turn.notice(NOW + 29_000)
      turn.completed(NOW + 31_000)
      turn.drain()
      expect(turn.errors()).toHaveLength(1)
      expect(turn.outcome()).toBe('failure')
    }
  })

  it('once, not twice, for a compaction whose error notice shows', () => {
    for (const deferred of [false, true]) {
      for (const stopped of [false, true]) {
        const turn = codexTurn({ deferred, command: true })
        if (stopped) {
          turn.stop('user-stop')
        }
        // Past the window, so a Stop leaves this notice's row too.
        turn.notice(NOW + 31_000)
        turn.completed(NOW + 32_000)
        turn.drain()
        expect(turn.errors()).toHaveLength(1)
      }
    }
  })

  it('for a compaction Codex ended without a marker and no Stop', () => {
    const turn = codexTurn({ command: true })
    turn.completed(NOW + 2_000)
    expect(turn.errors()).toHaveLength(1)
    expect(turn.outcome()).toBe('failure')
  })
})

describe('a failed completion the writer refuses', () => {
  it('returns the refusal, so the frame is retried rather than its row lost', () => {
    const turn = codexTurn()
    turn.stop('user-stop')
    turn.notice(NOW + 29_000)
    turn.reject(true)
    const [admission] = turn.failed(NOW + 31_000)
    expect(admission).toMatchObject({ accepted: false })
    turn.reject(false)
    turn.failed(NOW + 31_000)
    expect(turn.errors()).toHaveLength(1)
  })
})
