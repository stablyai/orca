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
  // Each subagent's ending, with the model it last reported running on.
  const models = new Map<string, string>()
  const endings = new Map<string, string>()
  for (const edge of evidence) {
    if (edge.type === 'live' && edge.child.model) {
      models.set(edge.child.handle.id, `${edge.child.model}:${edge.child.effort}`)
    } else if (edge.type === 'ended') {
      const spent = `${edge.totalTokens} $${edge.cost?.toFixed(5)}`
      endings.set(edge.handle.id, `${edge.outcome} ${spent} ${edge.lastMessage ?? ''}`.trim())
    }
  }
  return [...endings].map(([id, ending]) => `${id} on ${models.get(id)}: ${ending}`)
}

describe('OMP task subagents', () => {
  it('ends each subagent of a blocking task call with its reply, tokens, cost and model', () => {
    expect(replay('omp-v19-task-subagents.jsonl')).toEqual([
      'Ping on claude-haiku-5-5:high: succeeded 11244 $0.00225 PONG',
      'Refuse on claude-haiku-5-5:high: succeeded 11393 $0.00232 Status: aborted\nError: refused on purpose',
      'Count on claude-haiku-5-5:high: succeeded 13008 $0.00308 1'
    ])
  })

  it('ends background subagents from the progress their call keeps reporting', () => {
    expect(replay('omp-v19-task-subagents-async.jsonl')).toEqual([
      'Ping on gpt-6-luna:medium: succeeded 6745 $0.00068',
      'Count on gpt-6-luna:medium: succeeded 7636 $0.00104'
    ])
  })
})
