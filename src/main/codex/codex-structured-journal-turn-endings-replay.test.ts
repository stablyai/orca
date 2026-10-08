// Real `codex app-server` frame orders, replayed through the translator.
//
// The fixture is trimmed from captures of the real binary on 0.141.0 (the oldest
// version Orca exercises) and 0.158.0, with only the upstream provider faked:
// statuses, `willRetry`, the provider's sentence and `durationMs`, at the host
// receipt time `t` each frame arrived. Ids are replaced with synthetic ones.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalItemIdentity
} from '../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import {
  readCodexThreadId,
  readCodexTurnDurationMs,
  readCodexTurnId,
  readCodexTurnStatus
} from './codex-structured-thread-facts'

const SESSION_ID = 'session-1'

type CapturedFrame = { case: string; t: number; method: string; params: Record<string, unknown> }
type Row = { key: string; body: AgentJournalItemBody }

const FRAMES: CapturedFrame[] = readFileSync(
  join(__dirname, '__fixtures__', 'codex-app-server-turn-endings.jsonl'),
  'utf8'
)
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line))

function framesOf(name: string): CapturedFrame[] {
  const frames = FRAMES.filter((frame) => frame.case === name)
  expect(frames.length).toBeGreaterThan(0)
  return frames
}

/** Replays a case's frames, or only its first `count`. */
function replay(name: string, count = Number.POSITIVE_INFINITY) {
  const frames = framesOf(name).slice(0, count)
  const threadId = readCodexThreadId(frames[0]?.params) ?? ''
  const rows: Row[] = []
  const sink: StructuredAgentSessionEventSink = {
    appendItem: (identity: AgentJournalItemIdentity, body) =>
      rows.push({ key: agentJournalItemKey(identity), body }),
    appendTombstone: () => {},
    publish: () => {}
  }
  const translator = createCodexJournalTranslator({
    sink,
    sessionId: SESSION_ID,
    primaryThreadId: () => threadId
  })
  for (const frame of frames) {
    expect(
      translator.handle({
        type: 'notification',
        sessionId: SESSION_ID,
        threadId,
        method: frame.method,
        params: frame.params,
        observedAt: frame.t
      })
    ).toEqual({ accepted: true })
  }
  return { frames, rows, translator }
}

function turnWrites(rows: readonly Row[], turnId: string) {
  return rows
    .map((row) => row.body)
    .filter((body) => body.kind === 'turn' && body.turnId === turnId)
}

function terminalWrites(rows: readonly Row[], turnId: string) {
  return turnWrites(rows, turnId).filter((body) => body.kind === 'turn' && body.state !== 'running')
}

function receipt(frames: readonly CapturedFrame[], method: string, turnId: string): number {
  const frame = frames.find(
    (entry) => entry.method === method && readCodexTurnId(entry.params) === turnId
  )
  if (!frame) {
    throw new Error(`no ${method} for ${turnId}`)
  }
  return frame.t
}

function completion(frames: readonly CapturedFrame[], turnId: string) {
  const frame = frames.find(
    (entry) => entry.method === 'turn/completed' && readCodexTurnId(entry.params) === turnId
  )
  return frame
    ? {
        t: frame.t,
        status: readCodexTurnStatus(frame.params),
        durationMs: readCodexTurnDurationMs(frame.params)
      }
    : null
}

const VERDICT: Record<string, { state: string; outcome: string }> = {
  completed: { state: 'completed', outcome: 'success' },
  failed: { state: 'completed', outcome: 'failure' },
  interrupted: { state: 'interrupted', outcome: 'cancellation' }
}

const ENDED_CASES = [...new Set(FRAMES.map((frame) => frame.case))].filter(
  (name) => name !== '0.158.0-conn-refused'
)

describe('captured Codex turns end once, on their own completion', () => {
  it.each(ENDED_CASES)('%s', (name) => {
    const { frames, rows } = replay(name)
    const turnIds = frames
      .filter((frame) => frame.method === 'turn/started')
      .map((frame) => readCodexTurnId(frame.params) ?? '')

    expect(turnIds.length).toBeGreaterThan(0)
    for (const turnId of turnIds) {
      const end = completion(frames, turnId)
      expect(end).not.toBeNull()
      if (!end) {
        continue
      }
      const verdict = VERDICT[end.status ?? '']
      expect(verdict).toBeDefined()
      // One terminal write per turn, and it is Codex's own completion: its time,
      // its duration and its verdict, with the start this host saw.
      expect(terminalWrites(rows, turnId)).toEqual([
        expect.objectContaining({
          state: verdict?.state,
          outcome: verdict?.outcome,
          startedAt: receipt(frames, 'turn/started', turnId),
          completedAt: end.t,
          durationMs: end.durationMs
        })
      ])
    }
  })

  it('keeps every failed turn working through its error until the completion', () => {
    for (const name of ENDED_CASES) {
      const frames = framesOf(name)
      const failedTurns = frames
        .filter((frame) => frame.method === 'error' && frame.params.willRetry === false)
        .map((frame) => readCodexTurnId(frame.params) ?? '')
      for (const turnId of failedTurns) {
        const errorAt = frames.findIndex(
          (frame) =>
            frame.method === 'error' &&
            frame.params.willRetry === false &&
            readCodexTurnId(frame.params) === turnId
        )
        // Through the error, the turn is open; the completion right after it ends it.
        expect(terminalWrites(replay(name, errorAt + 1).rows, turnId)).toEqual([])
        expect(terminalWrites(replay(name).rows, turnId)).toHaveLength(1)
      }
    }
  })

  it('keeps a turn Codex is still retrying on 0.158.0 running, and the exit sweep ends it', () => {
    const { frames, rows, translator } = replay('0.158.0-conn-refused')
    const turnId =
      readCodexTurnId(frames.find((frame) => frame.method === 'turn/started')?.params) ?? ''
    const retries = frames.filter((frame) => frame.method === 'error')

    // Seven "Reconnecting... waiting for network" frames over four minutes, all
    // willRetry, and no completion: the turn is genuinely still open.
    expect(retries).toHaveLength(7)
    expect(retries.every((frame) => frame.params.willRetry === true)).toBe(true)
    expect(turnWrites(rows, turnId)).toEqual([
      expect.objectContaining({
        state: 'running',
        startedAt: receipt(frames, 'turn/started', turnId)
      })
    ])

    translator.handle({
      type: 'ended',
      sessionId: SESSION_ID,
      reason: 'lost child',
      cause: 'unexpected-exit',
      fence: 1,
      acquisitionGeneration: 'generation-1',
      observedAt: 250_000
    })

    expect(terminalWrites(rows, turnId)).toEqual([
      {
        kind: 'turn',
        turnId,
        state: 'interrupted',
        userItemId: `codex:${readCodexThreadId(frames[0]?.params)}:${turnId}:0`,
        startedAt: receipt(frames, 'turn/started', turnId),
        completedAt: 250_000
      }
    ])
  })
})
