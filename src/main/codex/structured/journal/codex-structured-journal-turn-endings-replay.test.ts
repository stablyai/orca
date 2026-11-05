import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalItemIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { StructuredAgentSessionEventSink } from '../../../native-chat/agent-session-wire/structured-agent-session-event-sink'
import { createCodexJournalTranslator } from './codex-structured-journal-translation'
import { readCodexThreadId, readCodexTurnId } from '../../app-server/codex-structured-thread-facts'

const SESSION_ID = 'session-1'

type CapturedFrame = { case: string; t: number; method: string; params: Record<string, unknown> }
type Row = { key: string; body: AgentJournalItemBody }

// Captured app-server 0.141.0/0.158.0 frames retain receipt times; IDs are synthetic.
const FRAMES: CapturedFrame[] = readFileSync(
  join(__dirname, '../../__fixtures__/codex-app-server-turn-endings.jsonl'),
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

const ENDED_CASES = [...new Set(FRAMES.map((frame) => frame.case))].filter(
  (name) => name !== '0.158.0-conn-refused'
)

describe('captured Codex turns end once, on their own completion', () => {
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
