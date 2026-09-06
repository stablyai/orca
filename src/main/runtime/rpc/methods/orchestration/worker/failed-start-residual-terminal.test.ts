import { afterEach, describe, expect, it } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { resolveResidualAgentTerminal } from './failed-start-residual-terminal'
import { failWorkerStartWithReceipt } from './worker-start-receipt'
import type { WorkerEffect } from './worker-topology'

const HANDLE = 'term_residual'
const PANE_KEY = 'tab_residual:leaf_residual'
const INCARNATION = 'pty-residual:1'

const createdAgentTerminal: WorkerEffect = {
  kind: 'terminal',
  role: 'agent',
  action: 'created',
  id: HANDLE,
  surface: 'visible'
}

function createRuntime(overrides: Partial<Record<string, unknown>> = {}): OrcaRuntimeService {
  return {
    getOrchestrationDispatchAuthority: () => ({
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      hostScope: { kind: 'local', hostId: 'local' }
    }),
    getTerminalPaneKey: () => PANE_KEY,
    getTerminalProcessIncarnation: () => INCARNATION,
    ...overrides
  } as unknown as OrcaRuntimeService
}

describe('residual agent terminal left by a failed start', () => {
  it('resolves identity for a terminal this start created', () => {
    expect(
      resolveResidualAgentTerminal({
        runtime: createRuntime(),
        effects: [createdAgentTerminal],
        terminalHandle: HANDLE,
        worktreeId: 'repo::worktree'
      })
    ).toEqual({
      terminalHandle: HANDLE,
      worktreeId: 'repo::worktree',
      paneKey: PANE_KEY,
      processIncarnation: INCARNATION,
      hostScope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })
  })

  it('resolves the agent-first worktree terminal the same way', () => {
    expect(
      resolveResidualAgentTerminal({
        runtime: createRuntime(),
        effects: [{ ...createdAgentTerminal, action: 'reused_agent_terminal' }],
        terminalHandle: HANDLE,
        worktreeId: null
      })
    ).toMatchObject({ terminalHandle: HANDLE })
  })

  it('never claims a caller-supplied terminal', () => {
    expect(
      resolveResidualAgentTerminal({
        runtime: createRuntime(),
        effects: [{ ...createdAgentTerminal, action: 'reused' }],
        terminalHandle: HANDLE,
        worktreeId: null
      })
    ).toBeUndefined()
  })

  it('never claims a setup terminal', () => {
    expect(
      resolveResidualAgentTerminal({
        runtime: createRuntime(),
        effects: [{ ...createdAgentTerminal, role: 'setup' }],
        terminalHandle: HANDLE,
        worktreeId: null
      })
    ).toBeUndefined()
  })

  it('refuses a pane whose process cannot be identified', () => {
    expect(
      resolveResidualAgentTerminal({
        runtime: createRuntime({
          getOrchestrationDispatchAuthority: () => null,
          getTerminalProcessIncarnation: () => null
        }),
        effects: [createdAgentTerminal],
        terminalHandle: HANDLE,
        worktreeId: null
      })
    ).toBeUndefined()
  })

  it('refuses when the start never resolved a terminal', () => {
    expect(
      resolveResidualAgentTerminal({
        runtime: createRuntime(),
        effects: [],
        terminalHandle: undefined,
        worktreeId: null
      })
    ).toBeUndefined()
  })

  it('stays silent when identity resolution throws', () => {
    expect(
      resolveResidualAgentTerminal({
        runtime: createRuntime({
          getOrchestrationDispatchAuthority: () => {
            throw new Error('handle retired')
          }
        }),
        effects: [createdAgentTerminal],
        terminalHandle: HANDLE,
        worktreeId: null
      })
    ).toBeUndefined()
  })
})

describe('failed worker-start receipt for a residual terminal', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function failStart(residual: boolean): { recovery?: string } {
    const d = (db = new OrchestrationDb(':memory:'))
    const task = d.createTask({ spec: 'residual receipt' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    d.recordWorkerStage({
      dispatchId: started.dispatch.id,
      stage: 'terminal_readying',
      terminalHandle: HANDLE,
      effects: [createdAgentTerminal],
      residualResources: [createdAgentTerminal]
    })
    return failWorkerStartWithReceipt({
      db: d,
      runId: 'run_residual',
      taskId: task.id,
      dispatchId: started.dispatch.id,
      failedStage: 'agent_readiness',
      error: new Error('Agent startup blocked: codex-interactive-prompt'),
      setup: {
        requested: 'not_applicable',
        effective: 'not_applicable',
        source: 'existing_worktree',
        hookFound: false,
        startupPolicy: 'start-immediately',
        state: 'not_applicable'
      },
      launch: { requested: { agent: 'codex' }, effective: { agent: 'codex' } } as never,
      ...(residual
        ? {
            residualAgentTerminal: {
              terminalHandle: HANDLE,
              worktreeId: 'repo::worktree',
              paneKey: PANE_KEY,
              processIncarnation: INCARNATION,
              hostScope: null
            }
          }
        : {})
    }) as { recovery?: string }
  }

  it('names worker-release for the terminal it left behind', () => {
    expect(failStart(true).recovery).toContain('worker-release')
  })

  it('promises no cleanup when there is no residual terminal', () => {
    expect(failStart(false).recovery).toBeUndefined()
  })
})
