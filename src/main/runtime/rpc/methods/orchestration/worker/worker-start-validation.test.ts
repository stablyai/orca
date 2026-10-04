import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrcaRuntimeWithGetTerminalInteractiveWait } from '../../../../orca-runtime-get-terminal-interactive-wait'
import type { TuiAgent } from '../../../../../../shared/tui-agent'
import {
  prepareLocalWorkerStart,
  validateFederatedWorkerStartPlacement
} from './worker-start-validation'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// Why the real prototype methods: the Settings resolution under test lives on the runtime.
function fakeRuntime(
  defaultTuiAgent: TuiAgent | 'blank' | null,
  disabledTuiAgents: TuiAgent[] = []
): { runtime: OrcaRuntimeService; resolveDefault: ReturnType<typeof vi.fn> } {
  const proto = OrcaRuntimeWithGetTerminalInteractiveWait.prototype
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validation reads only store settings and the two orchestration methods the fixture supplies.
  const runtime = {
    store: { getSettings: () => ({ defaultTuiAgent, disabledTuiAgents }) },
    validateOrchestrationAgentLauncher: proto.validateOrchestrationAgentLauncher
  } as unknown as OrcaRuntimeService & { resolveDefaultOrchestrationAgent: () => TuiAgent | null }
  const resolveDefault = vi.fn(() => proto.resolveDefaultOrchestrationAgent.call(runtime))
  runtime.resolveDefaultOrchestrationAgent = resolveDefault
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
        message: `--agent "${agent}" is not an agent id or a configured command alias.`
      })
    }
  })

  // Why: only the worker host knows its configured command aliases, so it validates the name.
  it('leaves a non-id remote --agent for the worker host to resolve', () => {
    expect(() =>
      validateFederatedWorkerStartPlacement({ ...baseParams, agent: 'codex-fugu' }, false)
    ).not.toThrow()
  })

  it('resolves a configured command alias instead of the Settings default', () => {
    const { runtime, resolveDefault } = fakeRuntime('gemini')
    const resolveAlias = vi.fn((name: string) => (name === 'codex-fugu' ? 'codex' : undefined))
    Object.assign(runtime, { resolveOrchestrationAgentLauncher: resolveAlias })
    const started = prepareLocalWorkerStart({
      params: { ...baseParams, agent: 'codex-fugu' },
      createsWorktree: false,
      runtime
    })
    expect(started.agent).toBe('codex')
    expect(resolveDefault).not.toHaveBeenCalled()
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

  it('refuses an explicit --agent that Settings disables', () => {
    expect(
      captureError(() =>
        prepareLocalWorkerStart({
          params: { ...baseParams, agent: 'codex' },
          createsWorktree: false,
          runtime: fakeRuntime('gemini', ['codex']).runtime
        })
      )
    ).toMatchObject({ code: 'agent_unconfigured' })
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
