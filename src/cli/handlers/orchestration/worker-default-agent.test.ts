import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { ORCHESTRATION_HANDLERS } from '../orchestration'
import { orchestrationTestContext } from '../orchestration-handler-test-context'

const callMock = vi.fn()
const originalExitCode = process.exitCode

beforeEach(() => {
  callMock.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.stubEnv('ORCA_TERMINAL_HANDLE', 'term_coord')
  vi.stubEnv('ORCA_AGENT_SESSION_ID', undefined)
})

afterEach(() => {
  process.exitCode = originalExitCode
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const invokeWorkerStart = (flags: Map<string, string | boolean>) =>
  ORCHESTRATION_HANDLERS['orchestration worker-start'](
    orchestrationTestContext(callMock, flags, true)
  )

describe('worker-start project default agent', () => {
  it('rejects --agent default before mutation on an older runtime', async () => {
    callMock.mockResolvedValueOnce({ result: { capabilities: [] } })

    await expect(
      invokeWorkerStart(
        new Map<string, string | boolean>([
          ['task', 'task_1'],
          ['agent', 'default'],
          ['from', 'term_coord']
        ])
      )
    ).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('forwards --agent default to a capable execution runtime', async () => {
    callMock
      .mockResolvedValueOnce({
        result: { capabilities: [PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        result: { runId: 'run_1', taskId: 'task_1', dispatchId: 'ctx_1', state: 'ready' }
      })

    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'default'],
        ['from', 'term_coord']
      ])
    )

    expect(callMock).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({ agent: 'default' })
    )
  })

  it('keeps the resolved target and selection source in the concise receipt', async () => {
    const agentSelection = {
      agent: 'codex',
      source: 'project',
      projectId: 'project-b',
      projectName: 'Project B'
    }
    callMock
      .mockResolvedValueOnce({
        result: { capabilities: [PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY] }
      })
      .mockResolvedValueOnce({
        result: {
          taskId: 'task_1',
          dispatchId: 'ctx_1',
          state: 'ready',
          agentSelection,
          launch: { effective: { agent: 'codex' } }
        }
      })

    await invokeWorkerStart(
      new Map<string, string | boolean>([
        ['task', 'task_1'],
        ['agent', 'default'],
        ['from', 'term_coord']
      ])
    )

    const output = JSON.parse(String(vi.mocked(console.log).mock.calls[0]?.[0]))
    expect(output.result).toMatchObject({ agent: 'codex', agentSelection })
  })
})
