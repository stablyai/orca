import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'

function fakeRuntime(defaultTuiAgent: string | null, disabled: string[] = []): OrcaRuntimeService {
  return {
    resolveDefaultOrchestrationAgent: () =>
      defaultTuiAgent && defaultTuiAgent !== 'blank' && !disabled.includes(defaultTuiAgent)
        ? defaultTuiAgent
        : null,
    validateOrchestrationAgentLauncher: vi.fn((agent: string) => {
      if (disabled.includes(agent)) {
        throw new Error('disabled')
      }
    })
  } as unknown as OrcaRuntimeService
}

const baseParams = { task: 'task_1', from: 'term_1', worktree: 'current' }

describe('worker-start agent resolution', () => {
  it('falls back to the Settings default agent when --agent is omitted', () => {
    const result = prepareLocalWorkerStart({
      params: baseParams,
      createsWorktree: false,
      runtime: fakeRuntime('bob')
    })
    expect(result.agent).toBe('bob')
    expect(result.launch.receipt.requested.agent).toBe('bob')
  })

  it('keeps an explicit --agent over the Settings default', () => {
    const result = prepareLocalWorkerStart({
      params: { ...baseParams, agent: 'codex' },
      createsWorktree: false,
      runtime: fakeRuntime('bob')
    })
    expect(result.agent).toBe('codex')
  })

  it('still fails when --agent is omitted and no usable default exists', () => {
    for (const runtime of [fakeRuntime(null), fakeRuntime('blank'), fakeRuntime('bob', ['bob'])]) {
      expect(() =>
        prepareLocalWorkerStart({ params: baseParams, createsWorktree: false, runtime })
      ).toThrow(/--agent/)
    }
  })

  it('does not consult the default when reusing a terminal', () => {
    const result = prepareLocalWorkerStart({
      params: { ...baseParams, terminal: 'term_2' },
      createsWorktree: false,
      runtime: fakeRuntime('bob')
    })
    expect(result.agent).toBeUndefined()
  })
})
