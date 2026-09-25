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

  it("carries a live task's error as what it last said, with no ending and no new state", () => {
    const decoder = decoderWith(backgroundAgent)
    // Shape from the SDK's declared `task_updated` patch; no capture has shown one on a live task.
    decoder.observe(
      system('task_updated', { task_id: 'agent-bg', patch: { error: 'Rate limited' } })
    )
    expect(decoder.drain(500)).toEqual([
      expect.objectContaining({
        type: 'live',
        child: expect.objectContaining({ state: 'working', lastMessage: 'Rate limited' })
      })
    ])
    decoder.observe(system('task_updated', { task_id: 'agent-unknown', patch: { error: 'x' } }))
    expect(decoder.drain(600)).toEqual([])
  })
})

describe('Claude children waiting on a permission request', () => {
  const states = (edges: ReturnType<ClaudeChildWorkDecoder['drain']>) =>
    edges.flatMap((edge) =>
      edge.type === 'live' ? [`${edge.child.handle.id} ${edge.child.state}`] : [edge.type]
    )

  it('reports a live child that starts or stops waiting, and only then', () => {
    const decoder = decoderWith(backgroundAgent)
    decoder.observeWaiting(new Set(['agent-bg', 'agent-untracked']))
    expect(states(decoder.drain(500))).toEqual(['agent-bg waiting'])
    decoder.observeWaiting(new Set(['agent-bg', 'agent-untracked']))
    expect(decoder.drain(600)).toEqual([])
    decoder.observeWaiting(new Set())
    expect(states(decoder.drain(700))).toEqual(['agent-bg working'])
  })

  it('reads every live report of a waiting child as waiting, a start included', () => {
    const decoder = new ClaudeChildWorkDecoder()
    // The request can name a child before its start is read.
    decoder.observeWaiting(new Set(['agent-bg']))
    decoder.observe(backgroundAgent)
    decoder.observe(foregroundAgent)
    decoder.observe(system('task_progress', { task_id: 'agent-bg', last_tool_name: 'Bash' }))
    expect(states(decoder.drain(500))).toEqual([
      'agent-bg waiting',
      'agent-fg working',
      'agent-bg waiting'
    ])
  })

  it('settles a waiting child on its own ending, and forgets every wait with the session', () => {
    const decoder = decoderWith(backgroundAgent)
    decoder.observeWaiting(new Set(['agent-bg']))
    decoder.observe(system('task_notification', { task_id: 'agent-bg', status: 'stopped' }))
    expect(states(decoder.drain(500))).toEqual(['agent-bg waiting', 'ended'])
    // Nothing is live to stop waiting.
    decoder.observeWaiting(new Set())
    expect(decoder.drain(600)).toEqual([])
    decoder.observe(system('task_started', { ...backgroundAgent, tool_use_id: 'toolu_bg_2' }))
    decoder.observeWaiting(new Set(['agent-bg']))
    decoder.clear()
    // The session's end frees every wait: nothing its drain carries reads waiting.
    const edges = states(decoder.drain(700))
    expect(edges.at(-1)).toBe('session-ended')
    expect(edges).not.toContain('agent-bg waiting')
  })
})
