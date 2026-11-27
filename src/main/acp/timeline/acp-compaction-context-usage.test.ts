import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GENERIC_ACP_DIALECT } from '../acp-dialects/acp-dialect'
import { OMP_ACP_DIALECT } from '../acp-dialects/omp-dialect'
import { AcpTimelineTranslator } from './acp-timeline-translator'

const SESSION = 'session-1'
const update = (value: unknown) => ({ sessionId: SESSION, update: value })
const usage = (used: number) => update({ sessionUpdate: 'usage_update', size: 200000, used })
const reply = (text: string) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } })

/** The session/update params an agent sent in a captured exchange. */
function capturedUpdates(name: string): unknown[] {
  const lines = readFileSync(join(import.meta.dirname, '../fixtures', name), 'utf8').trim()
  return lines.split('\n').flatMap((line) => {
    const { message } = JSON.parse(line)
    return message.method === 'session/update' ? [message.params] : []
  })
}

function compact(lane: AcpTimelineTranslator, frames: unknown[]) {
  lane.openPrompt('prompt-1', 1)
  lane.notification('session/update', usage(190000), 2)
  lane.promptResult('prompt-1', { stopReason: 'end_turn' }, 3)
  lane.openPrompt('compact-1', 4, 'compact:1')
  const events = frames.flatMap((frame) => lane.notification('session/update', frame, 5))
  events.push(...lane.promptResult('compact-1', { stopReason: 'end_turn' }, 6))
  return events.flatMap((event): unknown[] =>
    event.type === 'context.usage' ? [event.usage.used] : event.type === 'turn.end' ? ['end'] : []
  )
}

const ompLane = () => new AcpTimelineTranslator({ sessionId: SESSION, dialect: OMP_ACP_DIALECT })

describe('ACP compaction context usage', () => {
  it("restates OMP's post-compaction count, which OMP sends without a usage_update", () => {
    expect(compact(ompLane(), capturedUpdates('omp-v18-compact-success.jsonl'))).toEqual([
      { kind: 'estimate', capturedAt: 6, usage: expect.objectContaining({ inputTokens: 17109 }) },
      'end'
    ])
    expect(compact(ompLane(), capturedUpdates('omp-v18-compact-skip.jsonl'))).toEqual(['end'])
  })

  it("marks the count unknown when OMP's reply states no tokens", () => {
    expect(compact(ompLane(), [reply('Compaction complete.')])).toEqual([
      { kind: 'unknown', capturedAt: 6 },
      'end'
    ])
  })

  it('marks the count unknown when the agent reports no usage after compacting', () => {
    const lane = new AcpTimelineTranslator({ sessionId: SESSION, dialect: GENERIC_ACP_DIALECT })
    expect(compact(lane, [reply('Compacted.')])).toEqual([
      { kind: 'unknown', capturedAt: 6 },
      'end'
    ])
  })

  it("keeps the agent's own usage report from the compaction turn", () => {
    const lane = new AcpTimelineTranslator({ sessionId: SESSION, dialect: GENERIC_ACP_DIALECT })
    const used = compact(lane, [usage(12000), reply('Compacted.')])
    expect(used).toEqual([expect.objectContaining({ kind: 'estimate' }), 'end'])
  })
})
