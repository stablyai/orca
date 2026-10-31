import { expect, it } from 'vitest'
import { OmpRpcBackgroundTasks } from './rpc-background-tasks'

it('unwraps xd device execution and background Eval without turning foreground progress into a job', () => {
  const tasks = new OmpRpcBackgroundTasks()
  const device = (type: string, inner: unknown, tool = 'eval') =>
    tasks.receive({
      type,
      toolCallId: 'device',
      toolName: 'write',
      [type === 'tool_execution_end' ? 'result' : 'partialResult']: {
        details: { xdev: { tool, mode: 'execute', inner } }
      }
    })
  const details = { async: { jobId: 'cell', type: 'eval', state: 'running' } }
  expect(device('tool_execution_update', details)).toEqual([])
  expect(device('tool_execution_end', details)).toMatchObject([
    { type: 'live', child: { handle: { id: 'omp-job:cell' }, kind: 'workflow' } }
  ])
  const nested = {
    ...details,
    cells: [
      {
        views: [
          {
            view: {
              kind: 'json',
              value: {
                details: {
                  xdev: {
                    tool: 'bash',
                    mode: 'execute',
                    inner: { async: { jobId: 'command', type: 'bash', state: 'running' } }
                  }
                }
              }
            }
          }
        ]
      }
    ]
  }
  expect(device('tool_execution_update', nested)).toMatchObject([
    { type: 'live', child: { handle: { id: 'omp-job:cell' } } },
    { type: 'live', child: { handle: { id: 'omp-job:command' }, kind: 'command' } }
  ])
  expect(
    device('tool_execution_update', {
      async: { jobId: 'cell', type: 'eval', state: 'completed' }
    })
  ).toMatchObject([{ type: 'ended', handle: { id: 'omp-job:cell' }, outcome: 'succeeded' }])
  expect(
    device(
      'tool_execution_end',
      { op: 'wait', jobs: [{ id: 'command', type: 'bash', status: 'cancelled' }] },
      'wait'
    )
  ).toMatchObject([{ type: 'ended', handle: { id: 'omp-job:command' }, outcome: 'cancelled' }])
  expect(device('tool_execution_end', nested)).toEqual([])
})

it('settles a service returned by Eval using its proc snapshot without adopting other project services', () => {
  const tasks = new OmpRpcBackgroundTasks()
  tasks.receive({ type: 'message_end', message: { role: 'assistant', timestamp: 100 } })
  tasks.receive({ type: 'tool_execution_start', toolName: 'eval', toolCallId: 'eval' })
  tasks.receive({
    type: 'tool_execution_end',
    toolName: 'eval',
    toolCallId: 'eval',
    result: { details: { async: { jobId: 'cell', type: 'eval', state: 'running' } } }
  })
  const result = {
    details: {
      cells: [
        {
          views: [
            {
              view: {
                kind: 'json',
                value: { details: { service: { name: 'ci', state: 'ready', pid: 555 } } }
              }
            }
          ]
        }
      ]
    }
  }
  expect(
    tasks.receive({
      type: 'tool_execution_update',
      toolName: 'eval',
      toolCallId: 'eval',
      partialResult: result
    })
  ).toMatchObject([{ type: 'live', child: { name: 'ci', handle: { runId: 'eval:eval:0:0' } } }])
  const daemon = {
    id: 'daemon-ci',
    name: 'ci',
    startedAt: 110,
    state: 'exited',
    exitCode: 0
  }
  expect(
    tasks.receive({
      type: 'tool_execution_end',
      toolName: 'write',
      result: { details: { proc: { action: 'stop', daemon } } }
    })
  ).toMatchObject([{ type: 'ended', handle: { id: 'omp-service:ci' }, outcome: 'succeeded' }])
  expect(
    tasks.receive({ type: 'tool_execution_end', toolName: 'eval', toolCallId: 'eval', result })
  ).toEqual([])
  expect(
    tasks.receive({
      type: 'tool_execution_end',
      toolName: 'read',
      result: {
        details: { proc: { daemons: [{ ...daemon, name: 'another-session', state: 'ready' }] } }
      }
    })
  ).toEqual([])
})

it('discovers multiple background commands returned inside Eval JSON views before Eval finishes', () => {
  const tasks = new OmpRpcBackgroundTasks()
  const result = (jobId: string) => ({
    text: 'Backgrounded',
    details: {
      async: { state: 'running', jobId, type: 'bash' }
    }
  })
  const partialResult = {
    details: {
      cells: [
        {
          index: 0,
          status: 'complete',
          views: [
            { view: { kind: 'json', value: result('bg_1') } },
            { view: { kind: 'json', value: { batch: [result('bg_2')] } } },
            { view: { kind: 'json', value: 'details: { async: { jobId: "fake" } }' } }
          ]
        }
      ]
    }
  }
  const frame = {
    type: 'tool_execution_update',
    toolName: 'eval',
    toolCallId: 'eval',
    partialResult
  }
  expect(tasks.receive(frame)).toMatchObject([
    {
      type: 'live',
      child: { handle: { id: 'omp-job:bg_1' }, kind: 'command', residency: 'background' }
    },
    {
      type: 'live',
      child: { handle: { id: 'omp-job:bg_2' }, kind: 'command', residency: 'background' }
    }
  ])
  tasks.receive({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'async-result',
      details: {
        jobs: [
          { jobId: 'bg_1', status: 'completed' },
          { jobId: 'bg_2', status: 'completed' }
        ]
      }
    }
  })
  expect(tasks.receive({ ...frame, type: 'tool_execution_end', result: partialResult })).toEqual([])
})

it('discovers jobs from proc reads and observes cancellation without treating an empty roster as an ending', () => {
  const tasks = new OmpRpcBackgroundTasks()
  const read = (proc: unknown) =>
    tasks.receive({ type: 'tool_execution_end', toolName: 'read', result: { details: { proc } } })
  expect(
    read({ jobs: [{ id: 'job', type: 'bash', status: 'running', label: 'Watch CI' }] })
  ).toMatchObject([{ type: 'live', child: { name: 'Watch CI', kind: 'command' } }])
  expect(read({ jobs: [] })).toEqual([])
  expect(read({ job: { id: 'job', type: 'bash', status: 'cancelled' } })).toMatchObject([
    { type: 'ended', outcome: 'cancelled' }
  ])
})

it('tracks background jobs across partial wait snapshots and ignores duplicate or stale endings', () => {
  const tasks = new OmpRpcBackgroundTasks()
  tasks.receive({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: 'call',
    args: { command: 'python ci-wait.py' }
  })
  const details = { async: { state: 'running', jobId: 'bg_48', type: 'bash' } }
  expect(
    tasks.receive({
      type: 'tool_execution_update',
      toolName: 'bash',
      toolCallId: 'call',
      partialResult: { details }
    })
  ).toEqual([])
  expect(
    tasks.receive({
      type: 'tool_execution_end',
      toolName: 'bash',
      toolCallId: 'call',
      result: { details }
    })
  ).toMatchObject([
    {
      type: 'live',
      child: {
        handle: { id: 'omp-job:bg_48' },
        kind: 'command',
        residency: 'background',
        name: 'python ci-wait.py',
        stoppable: false
      }
    }
  ])
  expect(tasks.receive({ type: 'agent_end', awaitingAsyncWork: true })).toEqual([])
  expect(
    tasks.receive({
      type: 'tool_execution_end',
      toolName: 'wait',
      result: { details: { jobs: [] } }
    })
  ).toEqual([])
  const snapshot = {
    type: 'tool_execution_update',
    toolName: 'wait',
    partialResult: {
      details: {
        jobs: [
          {
            id: 'bg_48',
            type: 'bash',
            status: 'running',
            widget: { title: 'CI pipeline', stage: 'Waiting for a runner' }
          },
          { id: 'child', type: 'task', status: 'running', label: 'Already a native subagent' },
          { id: 'bad', type: 'future', status: 'running' },
          { id: 'eval', type: 'eval', status: 'pending', label: 'Evaluate' }
        ]
      }
    }
  }
  expect(tasks.receive(snapshot)).toMatchObject([
    {
      type: 'live',
      child: {
        name: 'CI pipeline',
        description: 'python ci-wait.py',
        lastMessage: 'Waiting for a runner'
      }
    },
    { type: 'live', child: { kind: 'workflow', state: 'waiting' } }
  ])
  const completion = {
    message: {
      role: 'custom',
      customType: 'async-result',
      details: {
        jobs: [
          { jobId: 'bg_48', type: 'bash', status: 'completed' },
          { jobId: 'eval', type: 'eval', status: 'failed' }
        ]
      }
    }
  }
  expect(tasks.receive({ type: 'message_start', ...completion })).toMatchObject([
    { type: 'ended', handle: { id: 'omp-job:bg_48' }, outcome: 'succeeded' },
    { type: 'ended', handle: { id: 'omp-job:eval' }, outcome: 'failed' }
  ])
  expect(tasks.receive({ type: 'message_end', ...completion })).toEqual([])
  expect(tasks.receive(snapshot)).toEqual([])
})

it('accepts terminal tool progress and does not resurrect jobs completed before discovery', () => {
  const tasks = new OmpRpcBackgroundTasks()
  tasks.receive({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'async-result',
      details: { jobs: [{ jobId: 'early', status: 'cancelled' }] }
    }
  })
  const background = (jobId: string, state: string, type = 'tool_execution_end') =>
    tasks.receive({
      type,
      toolName: 'bash',
      [type === 'tool_execution_end' ? 'result' : 'partialResult']: {
        details: { async: { jobId, state, type: 'bash' } }
      }
    })
  expect(background('early', 'running')).toEqual([])
  expect(background('active', 'running')).toHaveLength(1)
  expect(background('active', 'cancelled', 'tool_execution_update')).toMatchObject([
    { type: 'ended', outcome: 'cancelled' }
  ])
  expect(background('active', 'running')).toEqual([])
  expect(background('foreground', 'completed', 'tool_execution_update')).toEqual([])
  expect(background('foreground', 'running')).toEqual([])
  expect(background('unknown', 'running')).toHaveLength(1)
  expect(
    tasks.receive({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'async-result',
        details: { jobs: [{ jobId: 'unknown' }] }
      }
    })
  ).toMatchObject([{ type: 'ended', outcome: 'unknown' }])
})

it('bounds retained command previews and keeps malformed optional task data out of the stream', () => {
  const tasks = new OmpRpcBackgroundTasks()
  tasks.receive({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: 'call',
    args: { command: 'x'.repeat(20000) }
  })
  const evidence = tasks.receive({
    type: 'tool_execution_end',
    toolName: 'bash',
    toolCallId: 'call',
    result: { details: { async: { jobId: 'job', state: 'running', type: 'bash' } } }
  })
  const live = evidence[0]
  expect(live?.type === 'live' && live.child.description?.length).toBe(512)
  for (const details of [undefined, null, { async: null }, { jobs: [null, {}, { id: 'job' }] }]) {
    expect(
      tasks.receive({ type: 'tool_execution_end', toolName: 'wait', result: { details } })
    ).toEqual([])
  }
  expect(
    new OmpRpcBackgroundTasks().receive({
      type: 'message_end',
      message: {
        role: 'custom',
        customType: 'async-result',
        details: { jobs: [{ jobId: 'job', status: 'completed' }] }
      }
    })
  ).toEqual([])
})

function startService(
  tasks: OmpRpcBackgroundTasks,
  callId: string,
  nativeAt: number,
  pid?: number
) {
  tasks.receive({ type: 'message_end', message: { role: 'assistant', timestamp: nativeAt } })
  tasks.receive({
    type: 'tool_execution_start',
    toolName: 'bash',
    toolCallId: callId,
    args: { command: 'python ci-wait.py', name: 'ci' }
  })
  return tasks.receive({
    type: 'tool_execution_end',
    toolName: 'bash',
    toolCallId: callId,
    result: { details: { service: { name: 'ci', state: 'ready', pid } } }
  })
}

function completeService(tasks: OmpRpcBackgroundTasks, startedAt: number, pid?: number) {
  return tasks.receive({
    type: 'message_end',
    message: {
      role: 'custom',
      customType: 'launch-completion',
      details: {
        daemons: [
          { name: 'ci', id: `daemon-${startedAt}`, state: 'exited', startedAt, exitCode: 0, pid }
        ]
      }
    }
  })
}

it('fences same-name service replacements with native timestamps rather than the client clock', () => {
  const tasks = new OmpRpcBackgroundTasks()
  expect(startService(tasks, 'first', 100)).toMatchObject([
    { type: 'live', child: { handle: { id: 'omp-service:ci', runId: 'first' }, name: 'ci' } }
  ])
  expect(startService(tasks, 'second', 200)).toHaveLength(1)
  expect(completeService(tasks, 110)).toEqual([])
  expect(completeService(tasks, 210)).toMatchObject([
    { type: 'ended', handle: { id: 'omp-service:ci', runId: 'second' }, outcome: 'succeeded' }
  ])
  expect(completeService(tasks, 210)).toEqual([])
  expect(startService(tasks, 'second', 200)).toEqual([])
  expect(startService(tasks, 'third', 300)).toHaveLength(1)
  expect(completeService(tasks, 210)).toEqual([])
  expect(completeService(tasks, 310)).toHaveLength(1)
})

it('handles completion before a service result and refuses ambiguous same-turn service identity', () => {
  const tasks = new OmpRpcBackgroundTasks()
  expect(completeService(tasks, 110)).toEqual([])
  expect(startService(tasks, 'first', 100)).toMatchObject([
    { type: 'live' },
    { type: 'ended', handle: { runId: 'first' } }
  ])
  expect(startService(tasks, 'second', 100)).toHaveLength(1)
  expect(completeService(tasks, 120)).toEqual([])
  expect(startService(tasks, 'third', 200, 555)).toHaveLength(1)
  expect(completeService(tasks, 210, 444)).toEqual([])
  expect(completeService(tasks, 210, 555)).toHaveLength(1)
})
