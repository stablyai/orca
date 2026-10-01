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
import { createTrackedJournalOpener } from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { createDeferredStructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'

const SESSION = 'session-codex-failed-turn'
const THREAD = 'thread-abc'
const TURN = 'turn-1'

const journals = createTrackedJournalOpener()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup()
  }
})

async function session() {
  const root = await mkdtemp(join(tmpdir(), 'orca-codex-failed-turn-'))
  const journal = await journals.open({
    identity: {
      sessionId: SESSION,
      workspaceId: 'workspace-1',
      hostId: 'local',
      agent: 'codex',
      providerHandle: { kind: 'codex', threadId: THREAD }
    },
    stateDirectory: root,
    now: () => 1_000
  })
  const deferred = createDeferredStructuredAgentSessionEventSink()
  deferred.bind({ journal, fence: 1, publish: () => {} })
  cleanups.push(async () => {
    deferred.close()
    await journals.closeAll()
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

function turnRecord(rows: Awaited<ReturnType<Awaited<ReturnType<typeof session>>['items']>>) {
  return rows
    .map((item) => readAgentJournalTurn(item.body))
    .findLast((record) => record?.turnId === TURN)
}

describe('a failed Codex turn in the journal', () => {
  it('keeps the failed completion, its duration and the start, when it lands while the error is still queued', async () => {
    const { on, drained, items } = await session()
    on('turn/started', { turn: { id: TURN } }, 1_000)
    on(
      'item/completed',
      { turnId: TURN, item: { type: 'agentMessage', id: 'agent-1', text: 'Checking the build' } },
      1_500
    )
    await drained()

    // Codex writes both frames back to back; the error's status row is still being
    // written when the failed completion arrives.
    on(
      'error',
      { turnId: TURN, willRetry: false, error: { message: 'stream disconnected' } },
      3_000
    )
    on('turn/completed', { turn: { id: TURN, status: 'failed', durationMs: 1_900 } }, 3_100)

    const rows = await items()
    expect(turnRecord(rows)).toMatchObject({
      state: 'completed',
      outcome: 'failure',
      startedAt: 1_000,
      completedAt: 3_100,
      durationMs: 1_900
    })
    // "Worked for" under the turn's message reads Codex's own duration.
    expect(
      completedStructuredAgentTurnSeconds(selectStructuredAgentRunningTurnTiming(rows, TURN))
    ).toBe(1)
  })

  // Codex ends a turn once, so a second completion is not expected. If one came,
  // the settlement id keeps the first record, whether it is still queued or written.
  it.each([
    ['still queued', false],
    ['already written', true]
  ] as const)(
    'keeps the first completion when a second one arrives while the first is %s',
    async (_label, drainFirst) => {
      const { on, drained, items } = await session()
      on('turn/started', { turn: { id: TURN } }, 1_000)
      await drained()

      // The reply's row is being written, so the first completion waits behind it.
      on(
        'item/completed',
        { turnId: TURN, item: { type: 'agentMessage', id: 'agent-1', text: 'Done' } },
        1_900
      )
      on('turn/completed', { turn: { id: TURN, status: 'completed', durationMs: 900 } }, 2_000)
      if (drainFirst) {
        await drained()
      }
      on('turn/completed', { turn: { id: TURN, status: 'failed' } }, 3_000)

      expect(turnRecord(await items())).toMatchObject({
        state: 'completed',
        outcome: 'success',
        startedAt: 1_000,
        completedAt: 2_000,
        durationMs: 900
      })
    }
  )
})
