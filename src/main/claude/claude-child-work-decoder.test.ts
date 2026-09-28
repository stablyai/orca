import { describe, expect, it } from 'vitest'
import { ClaudeChildWorkDecoder } from './claude-child-work-decoder'

function system(subtype: string, fields: Record<string, unknown>): Record<string, unknown> {
  return { type: 'system', subtype, session_id: 'provider-1', uuid: crypto.randomUUID(), ...fields }
}

const foregroundAgent = system('task_started', {
  task_id: 'agent-fg',
  tool_use_id: 'toolu_fg',
  task_type: 'local_agent',
  subagent_type: 'Explore',
  description: 'Find flaky tests',
  is_backgrounded: false
})
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
  it('names a started child by its task id and the spawn call of this run', () => {
    const decoder = new ClaudeChildWorkDecoder()
    decoder.observe(foregroundAgent)
    expect(decoder.drain(500)).toEqual([
      {
        type: 'live',
        observedAt: 500,
        child: {
          handle: { idKind: 'task_id', id: 'agent-fg', runId: 'toolu_fg' },
          kind: 'agent',
          residency: 'foreground',
          state: 'working',
          name: 'Explore',
          agentType: 'Explore',
          description: 'Find flaky tests',
          stoppable: false
        }
      }
    ])
    expect(decoder.drain(600)).toEqual([])
  })

  it("carries a child's progress: the tool it last ran, its summary and its usage", () => {
    const decoder = decoderWith(foregroundAgent)
    decoder.observe(
      system('task_progress', {
        task_id: 'agent-fg',
        description: 'Running Bash',
        last_tool_name: 'Bash',
        summary: 'Reproducing the flake',
        usage: { total_tokens: 1_200, tool_uses: 3, duration_ms: 900 }
      })
    )
    expect(decoder.drain(600)).toEqual([
      expect.objectContaining({
        type: 'live',
        observedAt: 600,
        child: expect.objectContaining({
          handle: { idKind: 'task_id', id: 'agent-fg', runId: 'toolu_fg' },
          // The progress description restates the tool; the task keeps its own.
          description: 'Find flaky tests',
          operation: { toolName: 'Bash', basis: 'reported', observedAt: 600 },
          lastMessage: 'Reproducing the flake',
          totalTokens: 1_200
        })
      })
    ])
  })

  it('reports how a child ended in the outcome vocabulary, naming the run that ended', () => {
    const decoder = decoderWith(backgroundAgent)
    decoder.observe(
      system('task_notification', {
        task_id: 'agent-bg',
        tool_use_id: 'toolu_bg',
        status: 'failed',
        summary: 'Build broke',
        usage: { total_tokens: 900 }
      })
    )
    expect(decoder.drain(500)).toEqual([
      {
        type: 'ended',
        observedAt: 500,
        handle: { idKind: 'task_id', id: 'agent-bg', runId: 'toolu_bg' },
        outcome: 'failed',
        lastMessage: 'Build broke',
        totalTokens: 900
      }
    ])
    for (const [status, outcome] of [
      ['completed', 'succeeded'],
      ['killed', 'cancelled'],
      ['stopped', 'cancelled'],
      ['whatever', 'unknown']
    ]) {
      decoder.observe(system('task_notification', { task_id: 'agent-bg', status }))
      expect(decoder.drain(500)).toEqual([expect.objectContaining({ type: 'ended', outcome })])
    }
    decoder.observe(
      system('task_updated', { task_id: 'agent-bg', patch: { status: 'failed', error: 'OOM' } })
    )
    expect(decoder.drain(500)).toEqual([
      expect.objectContaining({ type: 'ended', outcome: 'failed', lastMessage: 'OOM' })
    ])
  })

  it("reads nothing from a roster, a turn's end or a spawn call's result", () => {
    const decoder = decoderWith(foregroundAgent, backgroundAgent)
    decoder.observe(system('background_tasks_changed', { tasks: [] }))
    decoder.observe({ type: 'result', subtype: 'success' })
    decoder.observe({
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: 'done', is_error: true }]
      }
    })
    expect(decoder.drain(500)).toEqual([])
  })

  it('moves a child to the background when the provider says it moved', () => {
    const decoder = decoderWith(foregroundAgent)
    decoder.observe(
      system('task_updated', { task_id: 'agent-fg', patch: { is_backgrounded: true } })
    )
    expect(decoder.drain(500)).toEqual([
      expect.objectContaining({
        child: expect.objectContaining({ residency: 'background', stoppable: true })
      })
    ])
  })

  it('reports a start for an ended child as a restart, and a late start of its run as nothing', () => {
    const decoder = decoderWith(
      backgroundAgent,
      system('task_notification', {
        task_id: 'agent-bg',
        tool_use_id: 'toolu_bg',
        status: 'completed'
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

  it('never records work the CLI hides from its transcript', () => {
    const decoder = new ClaudeChildWorkDecoder()
    decoder.observe({ ...backgroundAgent, ambient: true })
    decoder.observe({ ...foregroundAgent, skip_transcript: true })
    expect(decoder.drain(500)).toEqual([])
  })

  it('bounds the live children it tracks', () => {
    const decoder = new ClaudeChildWorkDecoder()
    for (let index = 0; index < 257; index += 1) {
      decoder.observe({ ...backgroundAgent, task_id: `agent-${index}` })
    }
    expect(decoder.drain(500)).toHaveLength(256)
  })

  it('marks the end of the provider session', () => {
    const decoder = decoderWith(backgroundAgent)
    decoder.clear()
    expect(decoder.drain(500)).toEqual([{ type: 'session-ended', observedAt: 500 }])
    // Nothing of the old session is remembered: a start is a first run again.
    decoder.observe(backgroundAgent)
    expect(decoder.drain(600)).toEqual([expect.not.objectContaining({ restart: true })])
  })
})
