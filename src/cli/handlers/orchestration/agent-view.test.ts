import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../selectors', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { orchestrationTestContext } from '../orchestration-handler-test-context'

const callMock = vi.fn()
const originalExitCode = process.exitCode

async function run(
  command: string,
  flags: [string, string | boolean][],
  result: unknown,
  json = false
): Promise<{ stdout: string; stderr: string; response: unknown }> {
  const response = { id: 'req_1', ok: true, result, _meta: { runtimeId: 'runtime_1' } }
  callMock.mockResolvedValue(response)
  const log = vi
    .spyOn(console, 'log')
    .mockClear()
    .mockImplementation(() => {})
  const error = vi
    .spyOn(console, 'error')
    .mockClear()
    .mockImplementation(() => {})
  await ORCHESTRATION_HANDLERS[`orchestration ${command}`](
    orchestrationTestContext(callMock, new Map(flags), json, '/repo')
  )
  return {
    stdout: log.mock.calls.map(([line]) => String(line)).join('\n'),
    stderr: error.mock.calls.map(([line]) => String(line)).join('\n'),
    response
  }
}

// An older runtime: no launch, mode, or next; the handle and workspace exist only in effects.
const OLDER_RUNTIME_START = {
  runId: 'run_1',
  taskId: 'task_1',
  dispatchId: 'ctx_1',
  state: 'ready',
  effects: [
    { kind: 'worktree', action: 'reused', id: 'wt_1::/repo' },
    { kind: 'terminal', role: 'agent', action: 'created', id: 'term_agent', surface: 'visible' }
  ],
  residualResources: [],
  prompt: { requestId: 'req_prompt', generation: 2 },
  mutation: { requestId: 'req_prompt', replayed: false }
}

describe('orchestration agent views', () => {
  beforeEach(() => {
    callMock.mockReset()
    process.exitCode = undefined
    vi.stubEnv('ORCA_CLI_COMMAND', 'orca-dev')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('prints a worker-start as the ids a reuse needs, and --full as the whole envelope', async () => {
    const flags: [string, string][] = [
      ['task', 'task_1'],
      ['from', 'term_coord']
    ]
    const concise = await run('worker-start', flags, OLDER_RUNTIME_START, true)
    expect(concise.stdout).toBe(
      '{"ok":true,"result":{"dispatchId":"ctx_1","taskId":"task_1","runId":"run_1","state":"ready","terminal":"term_agent","workspace":"wt_1::/repo"}}'
    )

    const full = await run('worker-start', [...flags, ['full', true]], OLDER_RUNTIME_START, true)
    expect(full.stdout).toBe(JSON.stringify(full.response, null, 2))
    expect(full.stderr).toBe('')
  })

  it('makes a failed worker-start impossible to miss on stdout, stderr, and the exit code', async () => {
    const { stdout, stderr } = await run('worker-start', [['task', 'task_1']], {
      ...OLDER_RUNTIME_START,
      state: 'failed',
      failedStage: 'agent_ready',
      lastError: 'Agent did not reach a ready prompt within 60000ms.',
      residualResources: [{ kind: 'terminal', id: 'term_agent', ownership: 'owned' }],
      recovery: 'Close it with: orca orchestration worker-release --dispatch ctx_1'
    })

    expect(stdout).toBe(
      [
        'Worker ctx_1 failed at agent_ready: Agent did not reach a ready prompt within 60000ms.',
        'Task task_1 in Run run_1',
        'Terminal term_agent in workspace wt_1::/repo',
        'Left behind: terminal term_agent',
        'Next: Close it with: orca-dev orchestration worker-release --dispatch ctx_1'
      ].join('\n')
    )
    expect(stderr).toBe(
      'error: start_failed: agent_ready: Agent did not reach a ready prompt within 60000ms.'
    )
    expect(process.exitCode).toBe(1)
  })

  it('prints a question with its payload flattened and a reply command for this executable', async () => {
    const question = {
      id: 'msg_q',
      run_id: 'run_1',
      from_handle: 'dispatch:ctx_1',
      to_handle: 'run:run_1',
      subject: 'Question',
      body: 'Remove the old flag now?',
      type: 'question',
      priority: 'normal',
      thread_id: 'msg_q',
      payload: JSON.stringify({
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        question: 'Remove the old flag now?',
        options: ['now', 'later']
      }),
      created_at: '2026-10-30T18:02:11Z',
      delivery_contract: 'current_delivery'
    }
    const result = {
      runId: 'run_1',
      deliveryId: 'delivery_1',
      deliveryAcknowledged: true,
      messages: [question],
      count: 1,
      timedOut: false
    }
    const flags: [string, string][] = [['run', 'run_1']]

    const json = await run('check', flags, result, true)
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      result: {
        messages: [
          {
            id: 'msg_q',
            type: 'question',
            from: 'ctx_1',
            body: 'Remove the old flag now?',
            taskId: 'task_1',
            options: ['now', 'later']
          }
        ]
      }
    })

    const text = await run('check', flags, result)
    expect(text.stdout).toBe(
      [
        'msg_q question from ctx_1 (task_1)',
        '  Remove the old flag now?',
        '  options: now | later',
        'Reply: orca-dev orchestration reply --id msg_q --body "..."'
      ].join('\n')
    )
  })

  it('never echoes a sent message back', async () => {
    const { stdout } = await run(
      'send',
      [
        ['from', 'term_worker'],
        ['to', 'run:run_1'],
        ['subject', 'Done'],
        ['body', 'A long summary the worker just wrote.']
      ],
      {
        message: { id: 'msg_done', body: 'A long summary the worker just wrote.', subject: 'Done' },
        lifecycle: { action: 'completed', autoReleaseAt: '2026-10-30T18:12:11Z' },
        next: 'Recorded. End your turn.'
      },
      true
    )

    expect(stdout).toBe(
      '{"ok":true,"result":{"messageId":"msg_done","lifecycle":"completed","autoReleaseAt":"2026-10-30T18:12:11Z","next":"Recorded. End your turn."}}'
    )
  })

  it('lists each worker with its agent terminal and a runnable next action', async () => {
    const { stdout } = await run('worker-list', [['run', 'run_1']], {
      workers: [
        {
          dispatchId: 'ctx_1',
          taskId: 'task_1',
          runId: 'run_1',
          workerState: 'running',
          dispatchStatus: 'dispatched',
          agentTerminalHandle: 'term_agent',
          terminalState: 'active',
          resource: { endpointIncarnation: 'internal' },
          projection: {
            host: { id: 'local' },
            workspace: { id: 'wt_1::/repo' },
            stage: { activity: 'working' },
            liveness: { verdict: 'live' },
            nextAction: { argv: ['orca', 'orchestration', 'worker-stop', '--dispatch', 'ctx_1'] }
          }
        }
      ],
      counts: { active: 1 }
    })

    expect(stdout).toBe(
      [
        'ctx_1 task_1 running liveness=live terminal=term_agent (active) workspace=wt_1::/repo next=orca-dev orchestration worker-stop --dispatch ctx_1',
        'Scope: Run run_1 (--run)'
      ].join('\n')
    )
  })
})
