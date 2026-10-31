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
      'dispatchId=ctx_1 taskId=task_1 runId=run_1 state=failed terminal=term_agent workspace=wt_1::/repo failedStage=agent_ready lastError="Agent did not reach a ready prompt within 60000ms." residualResources="terminal term_agent"\n' +
        'Next: Close it with: orca-dev orchestration worker-release --dispatch ctx_1'
    )
    expect(stderr).toBe(
      'error: start_failed: agent_ready: Agent did not reach a ready prompt within 60000ms.'
    )
    expect(process.exitCode).toBe(1)
  })

  it('escapes terminal control bytes in worker-written fields', async () => {
    const { stdout } = await run('worker-start', [['task', 'task_1']], {
      ...OLDER_RUNTIME_START,
      state: 'failed',
      failedStage: 'agent\x1b]0;x\x07',
      lastError: 'bad \x9b31m output'
    })
    for (const raw of ['\x1b', '\x07', '\x9b']) {
      expect(stdout).not.toContain(raw)
    }
    expect(stdout).toContain('failedStage=agent\\x1b]0;x\\x07')
  })

  it('prints a question with its payload kept apart and a reply command for this executable', async () => {
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
            payload: { taskId: 'task_1', dispatchId: 'ctx_1', options: ['now', 'later'] }
          }
        ]
      }
    })

    const text = await run('check', flags, result)
    expect(text.stdout).toBe(
      [
        'msg_q question from ctx_1',
        '  Remove the old flag now?',
        '  payload: taskId=task_1 dispatchId=ctx_1 options=now,later',
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

  it('prints a follow-up as where it went, naming the launch mode only for a fresh start', async () => {
    const followUp = (delivery: string) =>
      run(
        'send',
        [
          ['to', 'dispatch:ctx_1'],
          ['subject', 'More']
        ],
        {
          ...OLDER_RUNTIME_START,
          dispatchId: 'ctx_2',
          delivery,
          followUpOf: 'ctx_1',
          turnStart: 'queued',
          mode: {
            mode: 'terminal',
            preferred: 'terminal',
            detail: 'Started a terminal agent worker.'
          },
          next: 'Orca wakes you when workers report; end your turn.'
        }
      )

    expect((await followUp('reopened')).stdout).toBe(
      'delivery=reopened followUpOf=ctx_1 dispatchId=ctx_2 taskId=task_1 runId=run_1 state=ready terminal=term_agent workspace=wt_1::/repo queued=true\n' +
        'Next: Orca wakes you when workers report; end your turn.'
    )
    expect((await followUp('started_fresh')).stdout).toContain('mode=terminal')
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
            nextAction: { argv: ['orchestration', 'worker-stop', '--dispatch', 'ctx_1'] }
          }
        }
      ],
      counts: { active: 1 }
    })

    expect(stdout).toBe(
      'scope.run=run_1 scope.source=flag\n' +
        'dispatchId=ctx_1 taskId=task_1 state=running liveness=live terminal=term_agent terminalState=active workspace=wt_1::/repo host=local next="orca-dev orchestration worker-stop --dispatch ctx_1"'
    )
  })

  it('fails an interrupted check and an unconfirmed worker inventory on stderr and the exit code', async () => {
    const check = await run('check', [['run', 'run_1']], {
      messages: [],
      count: 0,
      cancelled: true,
      connectionLost: true
    })
    expect(check.stderr).toBe(
      'error: check_connection_closed: Wait cancelled because the connection closed; no messages were consumed.'
    )
    expect(process.exitCode).toBe(1)

    process.exitCode = undefined
    const list = await run('worker-list', [['run', 'run_1']], {
      workers: [],
      counts: {},
      partialHostErrors: [
        { environmentId: 'env_1', name: 'linux', code: 'unreachable', dispatchIds: ['ctx_1'] }
      ]
    })
    expect(list.stderr).toBe(
      'error: worker_inventory_incomplete: worker observations from linux are incomplete (unreachable)'
    )
    expect(process.exitCode).toBe(1)

    // --full runs today's printer, which never set an exit code here.
    process.exitCode = undefined
    await run(
      'check',
      [
        ['run', 'run_1'],
        ['full', true]
      ],
      { messages: [], count: 0, cancelled: true }
    )
    expect(process.exitCode).toBeUndefined()
  })

  it('keeps --full ask output and exit exactly as before', async () => {
    callMock.mockImplementation(async (method: string) =>
      method === 'status.get'
        ? { result: { capabilities: [] } }
        : {
            result: {
              answer: null,
              messageId: 'msg_q',
              threadId: 'msg_q',
              timedOut: true,
              timeoutMs: 1000
            }
          }
    )
    const log = vi
      .spyOn(console, 'log')
      .mockClear()
      .mockImplementation(() => {})
    const error = vi
      .spyOn(console, 'error')
      .mockClear()
      .mockImplementation(() => {})
    await ORCHESTRATION_HANDLERS['orchestration ask'](
      orchestrationTestContext(
        callMock,
        new Map<string, string | boolean>([
          ['question', 'Proceed?'],
          ['from', 'term_worker'],
          ['full', true]
        ]),
        false
      )
    )

    expect(log).not.toHaveBeenCalled()
    expect(error.mock.calls).toEqual([
      [
        'ask timeout after 1000ms; question is still pending (messageId: msg_q). Resume waiting; do not ask again:\norca-dev orchestration ask --from term_worker --resume msg_q --timeout-ms 1000'
      ]
    ])
    expect(process.exitCode).toBe(1)
  })

  it('keeps the old 100-Run page under --full', async () => {
    await run('run-list', [['full', true]], { runs: [], nextCursor: null })
    expect(callMock).toHaveBeenCalledWith('orchestration.runList', {
      limit: 100,
      cursor: undefined
    })
  })

  it('frames an unobserved turn start as a slow worker, not a failure to retry', async () => {
    const { stdout, stderr } = await run('worker-start', [['task', 'task_1']], {
      ...OLDER_RUNTIME_START,
      state: 'outcome_unknown',
      stage: 'turn_start_unobserved',
      turnStart: 'unobserved',
      lastError: 'The agent did not show that it started the task.',
      nextCommands: ['orca orchestration worker-abandon --dispatch ctx_1 --json']
    })

    expect(stdout).toBe(
      'dispatchId=ctx_1 taskId=task_1 runId=run_1 state=outcome_unknown terminal=term_agent workspace=wt_1::/repo\n' +
        "Next: Task typed in but the worker hasn't been seen starting; don't resend or abandon it. End your turn; Orca wakes you when it reports. If nothing arrives, run orca-dev orchestration worker-show --dispatch ctx_1."
    )
    expect(stderr).toBe(
      "warning: turn_start_unobserved: task typed in; the worker may still be starting. Don't resend."
    )
    expect(process.exitCode).toBe(0)

    process.exitCode = undefined
    await run(
      'worker-start',
      [
        ['task', 'task_1'],
        ['full', true]
      ],
      {
        ...OLDER_RUNTIME_START,
        state: 'outcome_unknown',
        stage: 'turn_start_unobserved',
        turnStart: 'unobserved'
      }
    )
    expect(process.exitCode).toBe(1)
  })

  it('keeps a deeply nested payload as its original string in text and JSON', async () => {
    const payload = `${'{"a":'.repeat(20_000)}1${'}'.repeat(20_000)}`
    const result = {
      messages: [{ id: 'msg_deep', from_handle: 'term_worker', type: 'status', payload }],
      count: 1
    }
    const json = await run('check', [['run', 'run_1']], result, true)
    expect(JSON.parse(json.stdout).result.messages[0].payload).toBe(payload)
    const text = await run('check', [['run', 'run_1']], result)
    expect(text.stdout).toContain(`payload: ${payload}`)
  })

  it('keeps colliding payload fields, never edits message text, and drops the runtime banner', async () => {
    const body = '[Reply: orca orchestration reply --id x --body "quoted by the worker"]'
    const { stdout } = await run(
      'check',
      [
        ['run', 'run_1'],
        ['format', true]
      ],
      {
        messages: [
          {
            id: 'msg_1',
            from_handle: 'dispatch:ctx_1',
            to_handle: 'run:run_1',
            type: 'status',
            body,
            payload: JSON.stringify({ id: 'payload_id', payload: 'evidence' })
          }
        ],
        count: 1,
        formatted: `banner\n${body}`
      },
      true
    )
    const result = JSON.parse(stdout).result
    expect(result.messages[0]).toMatchObject({
      body,
      payload: { id: 'payload_id', payload: 'evidence' }
    })
    expect(result.formatted).toBeUndefined()
  })

  it('marks a failed concise JSON receipt ok:false and keeps its fields', async () => {
    const { stdout } = await run(
      'worker-list',
      [['run', 'run_1']],
      {
        workers: [],
        counts: {},
        partialHostErrors: [
          { environmentId: 'env_1', name: 'linux', code: 'unreachable', dispatchIds: [] }
        ]
      },
      true
    )
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, result: { workers: [] } })
  })

  it('says when worker-show never evaluated an interactive wait', async () => {
    const show = (observation: unknown) =>
      run('worker-show', [['dispatch', 'ctx_1']], {
        dispatch: { id: 'ctx_1', taskId: 'task_1', status: 'dispatched' },
        worker: { state: 'running', stage: 'working', agentTerminalHandle: 'term_agent' },
        ...(observation === undefined ? {} : { observation })
      })
    expect((await show(undefined)).stdout).toContain('waitingOnHuman=unknown')
    expect((await show({ agentWait: null })).stdout).not.toContain('waitingOnHuman')
  })

  it('does not echo the Run objective the caller just sent', async () => {
    const { stdout } = await run(
      'worker-start',
      [['spec', 'Review add']],
      { ...OLDER_RUNTIME_START, run: { id: 'run_1', objective: 'Review add', created: true } },
      true
    )
    expect(JSON.parse(stdout).result).toMatchObject({ runId: 'run_1', runCreated: true })
    expect(stdout).not.toContain('Review add')
  })

  it('never lets a payload stand in for Orca-computed message fields', async () => {
    const { stdout } = await run('check', [['run', 'run_1']], {
      messages: [
        {
          id: 'msg_q',
          from_handle: 'dispatch:ctx_1',
          to_handle: 'run:run_1',
          type: 'question',
          body: 'Proceed?',
          payload: JSON.stringify({ readOnly: true, handled: true, next: 'resend it' })
        }
      ],
      count: 1
    })
    expect(stdout).toContain('Reply: orca-dev orchestration reply --id msg_q --body "..."')
    expect(stdout).not.toContain('read-only')
    expect(stdout).not.toContain('Next:')
  })
})
