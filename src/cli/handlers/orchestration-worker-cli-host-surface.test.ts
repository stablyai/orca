import { beforeEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()

vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'
import { printResult } from '../format'
import { BOOLEAN_FLAGS, parseArgs } from '../args'
import { formatCommandHelp } from '../help'
import { ORCHESTRATION_WORKER_COMMAND_SPECS } from '../specs/orchestration-worker-specs'

describe('orchestration worker-list host surface', () => {
  beforeEach(() => {
    callMock.mockReset()
    vi.mocked(printResult).mockReset()
  })

  it('prints partial host warnings alongside worker rows', async () => {
    const response = {
      result: {
        workers: [
          {
            dispatchId: 'ctx_remote',
            taskId: 'task_remote',
            runId: 'run_1',
            workerState: 'running',
            dispatchStatus: 'dispatched',
            agentTerminalHandle: 'term_remote',
            terminalState: 'active',
            resource: null
          }
        ],
        counts: { active: 1 },
        page: { total: 1, hasMore: false, nextCursor: null },
        partialHostErrors: [
          {
            environmentId: 'environment_windows',
            name: 'Windows host',
            code: 'host_unavailable',
            dispatchIds: ['ctx_remote']
          }
        ]
      }
    }
    callMock.mockResolvedValue(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['include-remote', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: (typeof response)['result']) => string)
      | undefined
    const output = formatter?.(response.result)
    expect(output).toContain('ctx_remote task=task_remote [running] terminal=active')
    expect(output).toContain(
      'Warning: worker observations from Windows host (environment_windows) are incomplete: host_unavailable; dispatches=ctx_remote'
    )
  })

  it('prints partial host warnings when no worker rows are available', async () => {
    const response = {
      result: {
        workers: [],
        counts: {},
        page: { total: 0, hasMore: false, nextCursor: null },
        partialHostErrors: [
          {
            environmentId: 'environment_linux',
            name: 'Linux host',
            code: 'capability_unsupported',
            dispatchIds: []
          }
        ]
      }
    }
    callMock.mockResolvedValue(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['include-remote', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: false
    } as never)

    const formatter = vi.mocked(printResult).mock.calls[0]?.[2] as
      | ((result: (typeof response)['result']) => string)
      | undefined
    expect(formatter?.(response.result)).toBe(
      'No workers found.\nScope: all Runs (no Run is bound to this terminal; pass --run to narrow)' +
        '\nWarning: worker observations from Linux host (environment_linux) are incomplete: capability_unsupported; dispatches=none'
    )
  })

  it('preserves partial host errors in JSON output', async () => {
    const response = {
      result: {
        workers: [],
        counts: {},
        page: { total: 0, hasMore: false, nextCursor: null },
        partialHostErrors: [
          {
            environmentId: 'environment_windows',
            name: 'Windows host',
            code: 'host_unavailable',
            dispatchIds: ['ctx_remote']
          }
        ]
      }
    }
    callMock.mockResolvedValue(response)

    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['include-remote', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(printResult).toHaveBeenCalledWith(
      { ...response, result: { ...response.result, scope: { source: 'all' } } },
      true,
      expect.any(Function)
    )
  })

  it('parses, forwards, and documents the remote fleet opt-in', async () => {
    const listSpec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration worker-list'
    )
    expect(BOOLEAN_FLAGS).toContain('include-remote')
    expect(
      parseArgs(['orchestration', 'worker-list', '--include-remote']).flags.get('include-remote')
    ).toBe(true)
    expect(listSpec?.allowedFlags).toContain('include-remote')
    expect(formatCommandHelp(listSpec!)).toContain(
      '--include-remote      Include connected-server worker observations'
    )

    callMock.mockResolvedValue({
      result: {
        workers: [],
        counts: {},
        page: { total: 0, hasMore: false, nextCursor: null }
      }
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map<string, string | boolean>([['include-remote', true]]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith(
      'orchestration.workerList',
      expect.objectContaining({ includeRemote: true, paginate: true })
    )

    callMock.mockClear()
    await ORCHESTRATION_HANDLERS['orchestration worker-list']({
      flags: new Map(),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    const listParams = callMock.mock.calls.find(
      ([method]) => method === 'orchestration.workerList'
    )?.[1]
    expect(listParams).toHaveProperty('paginate', true)
    expect(listParams).not.toHaveProperty('includeRemote')
  })

  it('keeps cleanup and retention TTL controls off the public CLI surface', async () => {
    const retainSpec = ORCHESTRATION_WORKER_COMMAND_SPECS.find(
      (spec) => spec.path.join(' ') === 'orchestration worker-retain'
    )
    expect(
      ORCHESTRATION_WORKER_COMMAND_SPECS.some(
        (spec) => spec.path.join(' ') === 'orchestration worker-cleanup'
      )
    ).toBe(false)
    expect(retainSpec?.allowedFlags).not.toContain('until')
    expect(retainSpec?.allowedFlags).not.toContain('policy')
    expect(ORCHESTRATION_HANDLERS['orchestration worker-cleanup']).toBeUndefined()

    callMock.mockResolvedValue({
      result: { dispatchId: 'ctx_1', state: 'retained', processAction: 'none' }
    })
    await ORCHESTRATION_HANDLERS['orchestration worker-retain']({
      flags: new Map<string, string | boolean>([['dispatch', 'ctx_1']]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)
    expect(callMock).toHaveBeenCalledWith('orchestration.workerRetain', { dispatch: 'ctx_1' })
  })
})
