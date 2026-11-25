import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status/child-work/agent-status-child-work-evidence'
import { AcpTimelineTranslator } from '../timeline/acp-timeline-translator'
import { OMP_ACP_DIALECT } from './omp-dialect'

const frameSchema = z.looseObject({
  direction: z.enum(['in', 'out']),
  message: z.looseObject({
    id: z.number().optional(),
    method: z.string().optional(),
    params: z.unknown().optional(),
    result: z.unknown().optional()
  })
})

// Recorded from `omp acp` 19.1.1: one task call running several subagents.
function replay(fixture: string): string[] {
  const frames = readFileSync(join(import.meta.dirname, '../fixtures', fixture), 'utf8')
    .trim()
    .split('\n')
    .map((line) => frameSchema.parse(JSON.parse(line)))
  const lane = new AcpTimelineTranslator({ sessionId: 'session-1', dialect: OMP_ACP_DIALECT })
  const evidence: AgentChildWorkEvidence[] = []
  frames.forEach(({ direction, message }, at) => {
    if (direction === 'out' && message.method === 'session/prompt') {
      lane.openPrompt(`send-${message.id}`, at)
    } else if (direction === 'in' && message.method === 'session/update') {
      lane.notification('session/update', message.params, at)
    } else if (direction === 'in' && message.result !== undefined) {
      // Both recordings' prompts end normally.
      lane.promptResult(`send-${message.id}`, { stopReason: 'end_turn' }, at)
    }
    evidence.push(...lane.subagents.drainEvidence())
  })
  // Each subagent's last word: its final live description or its ending.
  const last = new Map<string, string>()
  for (const edge of evidence) {
    if (edge.type === 'live') {
      const tokens = edge.child.totalTokens === undefined ? '' : ` ${edge.child.totalTokens}`
      last.set(edge.child.handle.id, `working ${edge.child.description}${tokens}`)
    } else if (edge.type === 'ended') {
      last.set(
        edge.handle.id,
        `${edge.outcome} ${edge.totalTokens} ${edge.lastMessage ?? ''}`.trim()
      )
    }
  }
  return [...last].map(([id, state]) => `${id}: ${state}`)
}

describe('OMP task subagents', () => {
  it('ends each subagent of a blocking task call with its reply and tokens', () => {
    expect(replay('omp-v19-task-subagents.jsonl')).toEqual([
      'Count: succeeded 13008 1',
      'Ping: succeeded 11244 PONG',
      'Refuse: succeeded 11393 Status: aborted\nError: refused on purpose'
    ])
  })

  it('ends background subagents from the progress their call keeps reporting', () => {
    expect(replay('omp-v19-task-subagents-async.jsonl')).toEqual([
      'Ping: succeeded 6745',
      'Count: succeeded 7636'
    ])
  })
})
