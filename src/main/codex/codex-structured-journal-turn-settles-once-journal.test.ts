// A failed Codex turn through the real path its record takes:
// translator → deferred sink queue → on-disk journal → the shared turn-timing reader.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readAgentJournalTurn } from '../../shared/agent-session-turn-record'
import {
  completedStructuredAgentTurnSeconds,
  selectStructuredAgentRunningTurnTiming
} from '../../shared/structured-agent-session-turn-timing'
import { openAgentSessionJournal } from '../native-chat/agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const SESSION = 'session-codex-failed-turn'
const THREAD = 'thread-abc'
const TURN = 'turn-1'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function session() {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-failed-turn-'))
  const journal = await openAgentSessionJournal({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    journalDir: root,
    now: () => 1_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink()
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await journal.close()
    await rm(root, { recursive: true, force: true })
  })
  const translator = createCodexJournalTranslator({
    sink: deferred.sink,
    sessionId: SESSION,
    primaryThreadId: () => THREAD,
    schedule: (run) => {
      run()
      return () => {}
    }
  })
  const on = (method: string, params: Record<string, unknown>, observedAt: number) =>
    translator.handle({
      type: 'notification',
      sessionId: SESSION,
      threadId: THREAD,
      method,
      params: { threadId: THREAD, ...params },
      observedAt
    })
  return {
    on,
    drained: () => deferred.drained(),
    items: async () => {
      await deferred.drained()
      return journal.snapshot().items
    }
  }
}

describe('a failed Codex turn in the journal', () => {
  it('keeps the failure and its duration when the failed completion lands while the error is still queued', async () => {
    const { on, drained, items } = await session()
    on('turn/started', { turn: { id: TURN } }, 1_000)
    on(
      'item/completed',
      { turnId: TURN, item: { type: 'agentMessage', id: 'agent-1', text: 'Checking the build' } },
      1_500
    )
    await drained()

    // Codex writes both frames back to back; the error's status row is still being
    // written when the failed completion arrives, so the error's settlement is queued.
    on(
      'error',
      { turnId: TURN, willRetry: false, error: { message: 'stream disconnected' } },
      3_000
    )
    on('turn/completed', { turn: { id: TURN, status: 'failed', durationMs: 1_900 } }, 3_100)

    const rows = await items()
    const turn = rows
      .map((item) => readAgentJournalTurn(item.body))
      .findLast((record) => record?.turnId === TURN)
    expect(turn).toMatchObject({
      state: 'completed',
      outcome: 'failure',
      startedAt: 1_000,
      completedAt: 3_000
    })
    // The duration "Worked for" shows under the turn's message.
    expect(
      completedStructuredAgentTurnSeconds(selectStructuredAgentRunningTurnTiming(rows, TURN))
    ).toBe(2)
  })
})
