import { describe, expect, it } from 'vitest'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 'provider-1', uuid: crypto.randomUUID(), ...fields }
}
const backgroundAgent = system('task_started', {
  task_id: 'agent-bg',
  tool_use_id: 'toolu_bg',
  task_type: 'local_agent',
  description: 'Audit the build',
  is_backgrounded: true
})

function decoderWith(...messages: Record<string, unknown>[]): ClaudeChildWorkDecoder {
  const decoder = new ClaudeChildWorkDecoder()
  for (const message of messages) {
    decoder.observe(message)
  }
  decoder.drain(0)
  return decoder
}

describe('Claude child-work decoder', () => {
  it('reports a start for an ended child as a restart, and a late start of a stopped run as nothing', () => {
    const decoder = decoderWith(
      backgroundAgent,
      system('task_notification', {
        task_id: 'agent-bg',
        tool_use_id: 'toolu_bg',
        status: 'stopped'
      })
    )
    decoder.observe(backgroundAgent)
    decoder.observe(system('task_updated', { task_id: 'agent-bg', patch: { description: 'Late' } }))
    decoder.observe(system('task_progress', { task_id: 'agent-bg', last_tool_name: 'Read' }))
    expect(decoder.drain(500)).toEqual([])
    decoder.observe({ ...backgroundAgent, tool_use_id: 'toolu_resume' })
    decoder.observe(system('task_progress', { task_id: 'agent-bg', last_tool_name: 'Read' }))
    expect(decoder.drain(600)).toEqual([
      expect.objectContaining({
        type: 'live',
        restart: true,
        child: expect.objectContaining({
          handle: { idKind: 'task_id', id: 'agent-bg', runId: 'toolu_resume' }
        })
      }),
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({
          handle: { idKind: 'task_id', id: 'agent-bg', runId: 'toolu_resume' },
          operation: expect.objectContaining({ toolName: 'Read' })
        })
      })
    ])
  })
})
