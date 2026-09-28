// A Claude session's frames, through the real adapter, into the host's child records: the order
// the host receives them in, and the record each child ends up with.

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  frame,
  hostWithParent,
  producer,
  system,
  toolResult,
  toolUse
} from './claude-child-work-producer-harness.test-fixture'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))
afterEach(() => vi.restoreAllMocks())

describe('Claude structured child-work producer', () => {
  it('delivers evidence only after the journal wrote the frame and the legacy row republished', async () => {
    const { send, records } = await producer()
    send(toolUse('toolu_bg', 'Agent', { description: 'Audit the build' }))
    const deliveries = send(
      system('task_started', {
        task_id: 'agent-bg',
        tool_use_id: 'toolu_bg',
        task_type: 'local_agent',
        subagent_type: 'general-purpose',
        description: 'Audit the build',
        is_backgrounded: true
      })
    )
    const kinds = deliveries.map((delivery) => delivery.kind)
    // The frame's own rows, then the parent's republished row, and only then its children.
    expect(kinds.filter((kind) => kind === 'journal').length).toBeGreaterThan(0)
    expect(kinds.slice(kinds.indexOf('legacy'))).toEqual(['legacy', 'evidence'])
    expect(records()).toEqual([
      expect.objectContaining({ description: 'Audit the build', membership: 'live' })
    ])
  })

  it("settles each child only on its own ending, whatever the parent's turn or roster does", async () => {
    const { adapter, send, records, byDescription } = await producer()
    const steps: { message: Record<string, unknown>; check?: () => void }[] = [
      { message: toolUse('toolu_fg', 'Agent', { description: 'Find flaky tests' }) },
      {
        message: system('task_started', {
          task_id: 'agent-fg',
          tool_use_id: 'toolu_fg',
          task_type: 'local_agent',
          subagent_type: 'Explore',
          description: 'Find flaky tests',
          is_backgrounded: false
        })
      },
      // The foreground child starts a background shell of its own.
      {
        message: toolUse(
          'toolu_bash',
          'Bash',
          { command: 'npm test', run_in_background: true },
          'toolu_fg'
        ),
        // Its own call is what it is doing, previewed as a CLI row previews Bash.
        check: () =>
          expect(byDescription('Find flaky tests')?.operation).toMatchObject({
            toolName: 'Bash',
            input: 'npm test',
            basis: 'open'
          })
      },
      {
        message: system('task_started', {
          task_id: 'shell-1',
          tool_use_id: 'toolu_bash',
          task_type: 'local_bash',
          description: 'npm test',
          is_backgrounded: true
        }),
        check: () =>
          expect(byDescription('npm test')?.parentChildWorkId).toBe(
            byDescription('Find flaky tests')?.childWorkId
          )
      },
      {
        message: system('background_tasks_changed', {
          tasks: [{ task_id: 'shell-1', task_type: 'local_bash', description: 'npm test' }]
        })
      },
      {
        message: toolResult('toolu_bash', 'Command running in background', 'toolu_fg'),
        check: () => expect(byDescription('Find flaky tests')?.operation).toBeUndefined()
      },
      {
        message: system('task_progress', {
          task_id: 'agent-fg',
          description: 'Running Bash',
          last_tool_name: 'Bash',
          usage: { total_tokens: 1_200, tool_uses: 2, duration_ms: 800 }
        }),
        check: () =>
          expect(byDescription('Find flaky tests')).toMatchObject({
            operation: { toolName: 'Bash', basis: 'reported' },
            totalTokens: 1_200
          })
      },
      // The spawn call returning is the parent's view; the child's own frame ends it.
      {
        message: toolResult('toolu_fg', 'Two tests flake on CI'),
        check: () => expect(byDescription('Find flaky tests')?.membership).toBe('live')
      },
      {
        message: system('task_notification', {
          task_id: 'agent-fg',
          tool_use_id: 'toolu_fg',
          status: 'completed',
          summary: 'Two tests flake on CI'
        }),
        check: () =>
          expect(byDescription('Find flaky tests')).toMatchObject({
            membership: 'settled',
            outcome: 'succeeded',
            lastMessage: 'Two tests flake on CI'
          })
      },
      { message: toolUse('toolu_bg', 'Agent', { description: 'Audit the build' }) },
      {
        message: system('task_started', {
          task_id: 'agent-bg',
          tool_use_id: 'toolu_bg',
          task_type: 'local_agent',
          description: 'Audit the build',
          is_backgrounded: true
        })
      },
      {
        message: system('background_tasks_changed', {
          tasks: [
            { task_id: 'shell-1', task_type: 'local_bash', description: 'npm test' },
            { task_id: 'agent-bg', task_type: 'local_agent', description: 'Audit the build' }
          ]
        })
      },
      { message: frame({ type: 'result', subtype: 'success', is_error: false }) },
      // Claude drops a finished task from the roster BEFORE its outcome frame arrives.
      {
        message: system('background_tasks_changed', {
          tasks: [{ task_id: 'shell-1', task_type: 'local_bash', description: 'npm test' }]
        }),
        check: () => expect(byDescription('Audit the build')?.membership).toBe('live')
      },
      {
        message: system('task_notification', {
          task_id: 'agent-bg',
          status: 'failed',
          summary: 'Build broke',
          usage: { total_tokens: 900 }
        }),
        check: () =>
          expect(byDescription('Audit the build')).toMatchObject({
            membership: 'settled',
            outcome: 'failed',
            lastMessage: 'Build broke'
          })
      },
      {
        message: system('background_tasks_changed', { tasks: [] }),
        check: () => expect(byDescription('npm test')?.membership).toBe('live')
      },
      {
        message: system('task_updated', { task_id: 'shell-1', patch: { status: 'killed' } }),
        check: () => expect(byDescription('npm test')).toMatchObject({ outcome: 'cancelled' })
      },
      // Messaging a finished background agent starts it again under the message call.
      { message: toolUse('toolu_msg', 'SendMessage', { to: 'agent-bg', message: 'Again' }) },
      {
        message: system('task_started', {
          task_id: 'agent-bg',
          tool_use_id: 'toolu_msg',
          task_type: 'local_agent',
          description: 'Audit the build',
          is_backgrounded: true
        }),
        check: () =>
          expect(byDescription('Audit the build')).toMatchObject({
            membership: 'live',
            invocation: { invocationId: 'toolu_msg', generation: 2 },
            previousInvocations: [expect.objectContaining({ outcome: 'failed' })]
          })
      }
    ]
    for (const step of steps) {
      send(step.message)
      step.check?.()
    }
    await adapter.closeSession('session-1')
    // The session is gone: what still ran settles unreported, and every record stays.
    const summary = records().map((record) => ({
      description: record.description,
      membership: record.membership,
      outcome: record.outcome,
      generation: record.invocation.generation
    }))
    expect(summary).toEqual([
      {
        description: 'Find flaky tests',
        membership: 'settled',
        outcome: 'succeeded',
        generation: 1
      },
      { description: 'npm test', membership: 'settled', outcome: 'cancelled', generation: 1 },
      { description: 'Audit the build', membership: 'settled', outcome: 'unknown', generation: 2 }
    ])
    expect(adapter.backgroundTaskState('session-1')).toBeUndefined()
  })

  it("counts a child's runs the way the journal does, and ends each run on its own frame", async () => {
    const { adapter, send, byDescription, stamps } = await producer()
    const start = (toolUseId: string) =>
      system('task_started', {
        task_id: 'agent-fg',
        tool_use_id: toolUseId,
        task_type: 'local_agent',
        description: 'Find flaky tests',
        is_backgrounded: false
      })
    const childSays = (toolUseId: string, text: string) =>
      frame({
        type: 'assistant',
        parent_tool_use_id: toolUseId,
        message: { id: `msg-${text}`, role: 'assistant', content: [{ type: 'text', text }] }
      })
    // The journal stamps a child row with its roster attempt only once it is past the first.
    const runs = (toolUseId: string) => ({
      generation: byDescription('Find flaky tests')?.invocation.generation,
      attempt: stamps.findLast((stamp) => stamp.providerParentRef === toolUseId)?.attempt ?? 1
    })
    send(toolUse('toolu_1', 'Agent', { description: 'Find flaky tests' }))
    send(start('toolu_1'))
    send(childSays('toolu_1', 'first run'))
    expect(runs('toolu_1')).toEqual({ generation: 1, attempt: 1 })
    send(toolResult('toolu_1', 'Found it'))
    send(system('task_notification', { task_id: 'agent-fg', status: 'completed' }))

    // The provider runs the finished child again under a new spawn call.
    send(toolUse('toolu_2', 'Agent', { description: 'Find flaky tests' }))
    const legacy = adapter.backgroundTaskState('session-1')
    send(start('toolu_2'))
    // The legacy row still waits for a roster; the record hears the new run now.
    expect(adapter.backgroundTaskState('session-1')).toEqual(legacy)
    send(childSays('toolu_2', 'second run'))
    expect(runs('toolu_2')).toEqual({ generation: 2, attempt: 2 })
    send(
      system('task_progress', {
        task_id: 'agent-fg',
        last_tool_name: 'Grep',
        usage: { total_tokens: 300, tool_uses: 1, duration_ms: 10 }
      })
    )
    expect(byDescription('Find flaky tests')).toMatchObject({
      membership: 'live',
      operation: { toolName: 'Grep', basis: 'reported' },
      totalTokens: 300
    })
    // An errored spawn result says nothing about how the child ended.
    send(toolResult('toolu_2', 'Could not reproduce', null, true))
    expect(byDescription('Find flaky tests')?.membership).toBe('live')
    send(system('task_notification', { task_id: 'agent-fg', status: 'failed' }))
    expect(byDescription('Find flaky tests')).toMatchObject({
      membership: 'settled',
      outcome: 'failed',
      invocation: { invocationId: 'toolu_2', generation: 2 },
      previousInvocations: [expect.objectContaining({ outcome: 'succeeded' })]
    })
  })

  describe('a second ending for a settled child', () => {
    async function settledForegroundChild() {
      const host = hostWithParent()
      const warn = vi.spyOn(console, 'warn')
      const error = vi.spyOn(console, 'error')
      const run = await producer(host)
      run.send(toolUse('toolu_fg', 'Agent', { description: 'Find flaky tests' }))
      run.send(
        system('task_started', {
          task_id: 'agent-fg',
          tool_use_id: 'toolu_fg',
          task_type: 'local_agent',
          description: 'Find flaky tests',
          is_backgrounded: false
        })
      )
      run.send(
        system('task_notification', {
          task_id: 'agent-fg',
          tool_use_id: 'toolu_fg',
          status: 'completed',
          summary: 'Two tests flake on CI'
        })
      )
      expect(run.byDescription('Find flaky tests')).toMatchObject({
        membership: 'settled',
        outcome: 'succeeded',
        lastMessage: 'Two tests flake on CI'
      })
      return { ...run, warn, error }
    }

    it('keeps a definite outcome through an unclassified ending and lands its evidence', async () => {
      const { send, byDescription } = await settledForegroundChild()
      // A notification with no status the host can classify still carries the final summary.
      send(
        system('task_notification', {
          task_id: 'agent-fg',
          summary: 'Two tests flake on CI; both time out on the shared runner',
          usage: { total_tokens: 1_500 }
        })
      )
      expect(byDescription('Find flaky tests')).toMatchObject({
        membership: 'settled',
        outcome: 'succeeded',
        lastMessage: 'Two tests flake on CI; both time out on the shared runner',
        totalTokens: 1_500
      })
    })

    it('keeps the first definite outcome over a conflicting one, and reports no fault', async () => {
      const { send, byDescription, ingested, warn, error } = await settledForegroundChild()
      send(
        system('task_notification', {
          task_id: 'agent-fg',
          status: 'failed',
          summary: 'Crashed after returning'
        })
      )
      expect(byDescription('Find flaky tests')).toMatchObject({
        membership: 'settled',
        outcome: 'succeeded',
        lastMessage: 'Two tests flake on CI'
      })
      // Admission refuses it; the host counts that refusal as the fence doing its job.
      expect(ingested.at(-1)).toMatchObject({
        settled: 0,
        rejected: [{ handleId: 'agent-fg', reason: 'stale-invocation' }]
      })
      expect(warn).not.toHaveBeenCalled()
      expect(error).not.toHaveBeenCalled()
    })
  })
})
