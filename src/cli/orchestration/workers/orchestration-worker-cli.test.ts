import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
const originalExitCode = process.exitCode
vi.mock('../../output/command-result-output', async (importOriginal) => {
  const original = await importOriginal<{ printResult: typeof printResult }>()
  return { printResult: vi.fn(original.printResult) }
})
vi.mock('../../terminals/terminal-selector', () => ({ getTerminalHandle: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from '../orchestration-handlers'
import { printResult } from '../../output/command-result-output'

import { RuntimeClient } from '../../runtime/client'
import { RuntimeClientError } from '../../runtime/types'
import { parseArgs, validateCommandAndFlags } from '../../arguments/args'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../../specs/orchestration-worker-specs'

const client = new RuntimeClient('/tmp/orca-worker-cli', 60_000, null, null)

describe('orchestration worker-start CLI contract', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.spyOn(client, 'call').mockImplementation(callMock)
    vi.mocked(printResult).mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    process.exitCode = undefined
    vi.stubEnv('ORCA_CLI_COMMAND', undefined)
    vi.stubEnv('ORCA_DEV_CLI_INVOCATION', undefined)
    vi.stubEnv('ORCA_USER_DATA_PATH', undefined)
    vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
    vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const invokeWorkerStart = (flags: Map<string, string | boolean>, json = true) =>
    ORCHESTRATION_HANDLERS['orchestration worker-start']({
      flags,
      client,
      cwd: '/tmp/repo',
      json
    })

  it('sets an unsuccessful exit code for an unknown receipt', async () => {
    callMock.mockResolvedValue({
      result: {
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        state: 'outcome_unknown',
        effects: [],
        residualResources: []
      }
    })

    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['from', 'term_coord']
      ])
    )

    expect(process.exitCode).toBe(1)
  })

  it('carries a persisted caller request id into the native mutation envelope', async () => {
    callMock.mockResolvedValue({ result: { dispatchId: 'ctx_1', state: 'ready' } })
    const parsed = parseArgs([
      'orchestration',
      'worker-start',
      '--task',
      'task_1',
      '--agent',
      'codex',
      '--from',
      'term_coord',
      '--request-id',
      '11111111-2222-4333-8444-555555555555'
    ])
    validateCommandAndFlags(ORCHESTRATION_WORKER_COMMAND_SPECS, parsed)
    await invokeWorkerStart(parsed.flags)

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerStart',
      expect.objectContaining({ task: 'task_1', agent: 'codex', from: 'term_coord' }),
      { orchestrationRequestId: '11111111-2222-4333-8444-555555555555' }
    )
  })

  it('refuses malformed or conflicting caller identities before mutating', async () => {
    for (const identity of ['broken', true, false]) {
      const flags = new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'codex'],
        ['from', 'term_coord'],
        ['request-id', identity]
      ])
      await expect(invokeWorkerStart(flags)).rejects.toMatchObject({ code: 'invalid_argument' })
    }
    await expect(
      invokeWorkerStart(
        new Map([
          ['task', 'task_1'],
          ['agent', 'codex'],
          ['from', 'term_coord'],
          ['request-id', '11111111-2222-4333-8444-555555555555'],
          ['retry-request', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee']
        ])
      )
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(callMock).not.toHaveBeenCalled()
  })

  it('retains uncertainty for a caller-supplied id when preflight reports unsent', async () => {
    callMock.mockRejectedValue(
      new RuntimeClientError('runtime_unavailable', 'Unavailable', {
        orchestrationRequestId: '11111111-2222-4333-8444-555555555555',
        requestSent: false,
        originalCommand: [
          'orca',
          'orchestration',
          'worker-start',
          '--task',
          'task_1',
          '--request-id',
          '11111111-2222-4333-8444-555555555555'
        ]
      })
    )
    await expect(
      invokeWorkerStart(
        new Map([
          ['task', 'task_1'],
          ['agent', 'codex'],
          ['from', 'term_coord'],
          ['request-id', '11111111-2222-4333-8444-555555555555']
        ])
      )
    ).rejects.toMatchObject({
      data: {
        recovery: {
          disposition: 'outcome_unknown',
          retryCommand: [
            'orca',
            'orchestration',
            'worker-start',
            '--task',
            'task_1',
            '--retry-request',
            '11111111-2222-4333-8444-555555555555'
          ]
        }
      }
    })
  })
})
