import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'

function fakeRuntime(
  defaultTuiAgent: TuiAgent | 'blank' | null,
  disabled: TuiAgent[] = []
): { runtime: OrcaRuntimeService; resolveDefault: ReturnType<typeof vi.fn> } {
  const resolveDefault = vi.fn(() =>
    defaultTuiAgent && defaultTuiAgent !== 'blank' && !disabled.includes(defaultTuiAgent)
      ? defaultTuiAgent
      : null
  )
  const runtime = {
    resolveDefaultOrchestrationAgent: resolveDefault,
    validateOrchestrationAgentLauncher: vi.fn((agent: TuiAgent) => {
      if (disabled.includes(agent)) {
        throw new Error('disabled')
      }
    })
  } as unknown as OrcaRuntimeService
  return { runtime, resolveDefault }
}

const baseParams = { task: 'task_1', from: 'term_1', worktree: 'current' }

function captureError(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

describe('worker-start agent resolution', () => {
  it('falls back to the Settings default agent when --agent is omitted', () => {
    const result = prepareLocalWorkerStart({
      params: baseParams,
      createsWorktree: false,
      runtime: fakeRuntime('gemini').runtime
    })
    expect(result.agent).toBe('gemini')
    expect(result.launch.receipt.requested.agent).toBe('gemini')
  })

  it('keeps an explicit --agent over the Settings default', () => {
    const result = prepareLocalWorkerStart({
      params: { ...baseParams, agent: 'codex' },
      createsWorktree: false,
      runtime: fakeRuntime('gemini').runtime
    })
    expect(result.agent).toBe('codex')
  })

  it('rejects a mistyped --agent instead of falling back to the default', () => {
    for (const agent of ['codx', '']) {
      expect(
        captureError(() =>
          prepareLocalWorkerStart({
            params: { ...baseParams, agent },
            createsWorktree: false,
            runtime: fakeRuntime('gemini').runtime
          })
        )
      ).toMatchObject({
        code: 'agent_unconfigured',
        message: `Unknown --agent "${agent}".`
      })
    }
  })

  it('still fails when --agent is omitted and no usable default exists', () => {
    for (const { runtime } of [
      fakeRuntime(null),
      fakeRuntime('blank'),
      fakeRuntime('gemini', ['gemini'])
    ]) {
      expect(
        captureError(() =>
          prepareLocalWorkerStart({ params: baseParams, createsWorktree: false, runtime })
        )
      ).toMatchObject({
        code: 'agent_unconfigured',
        message: expect.stringContaining('--agent')
      })
    }
  })

  it('does not consult the default when reusing a terminal', () => {
    const { runtime, resolveDefault } = fakeRuntime('gemini')
    const result = prepareLocalWorkerStart({
      params: { ...baseParams, terminal: 'term_2' },
      createsWorktree: false,
      runtime
    })
    expect(result.agent).toBeUndefined()
    expect(resolveDefault).not.toHaveBeenCalled()
  })
})
