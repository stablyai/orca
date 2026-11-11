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

  it('requests native settings only for detailed worker inspection and preserves unknown evidence', async () => {
    const result = {
      dispatch: { id: 'ctx_1', taskId: 'task_1', status: 'active' },
      worker: { state: 'ready', stage: 'ready', agentTerminalHandle: null },
      settings: { kind: 'unknown', reason: 'not_live' }
    }
    const full = await run(
      'worker-show',
      [
        ['dispatch', 'ctx_1'],
        ['full', true]
      ],
      result,
      true
    )
    expect(callMock).toHaveBeenLastCalledWith('orchestration.workerShow', {
      dispatch: 'ctx_1',
      includeSettings: true
    })
    expect(JSON.parse(full.stdout).result.settings).toEqual({
      kind: 'unknown',
      reason: 'not_live'
    })

    await run('worker-show', [['dispatch', 'ctx_1']], result, true)
    expect(callMock).toHaveBeenLastCalledWith('orchestration.workerShow', { dispatch: 'ctx_1' })
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

  it('asks an older host to release only reclaimable finished workers', async () => {
    const worker = { taskId: 'task_1', runId: 'run_1', workerState: 'succeeded' }
    const { stdout } = await run(
      'worker-list',
      [['run', 'run_1']],
      {
        workers: [
          { ...worker, dispatchId: 'ctx_done', terminalState: 'reclaimable', resource: null },
          { ...worker, dispatchId: 'ctx_kept', terminalState: 'retained', resource: null }
        ],
        counts: {}
      },
      true
    )
    const [done, kept] = JSON.parse(stdout).result.workers
    expect(done.next).toContain('orchestration worker-release --dispatch ctx_done')
    expect(kept.next).toBeUndefined()
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

  it('previews inbox bodies and keeps only payload ids', async () => {
    const huge = 'x'.repeat(10_000)
    const inbox = await run(
      'inbox',
      [],
      {
        messages: [
          {
            id: 'msg_1',
            from_handle: 'dispatch:ctx_1',
            to_handle: 'run:run_1',
            subject: 'Done',
            body: huge,
            type: 'worker_done',
            payload: JSON.stringify({ taskId: 'task_1', dispatchId: { spec: huge }, notes: huge })
          }
        ],
        count: 1
      },
      true
    )
    const [row] = JSON.parse(inbox.stdout).result.messages
    expect(row.body).toBe(`${'x'.repeat(200)}… (truncated; --full)`)
    expect(row.payload).toEqual({ taskId: 'task_1' })
    const emoji = await run(
      'inbox',
      [],
      {
        messages: [
          { id: 'msg_2', from_handle: 'term_1', body: `${'x'.repeat(199)}${'😀'.repeat(5)}` }
        ],
        count: 1
      },
      true
    )
    expect(JSON.parse(emoji.stdout).result.messages[0].body).toBe(
      `${'x'.repeat(199)}😀… (truncated; --full)`
    )
  })
})
