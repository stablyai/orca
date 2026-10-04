import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import {
  applyWaitForSetupOutcome,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './worker-topology'

function residualWorkerEffects(effects: WorkerEffect[]): WorkerEffect[] {
  // 'reused_agent_terminal' is the retired verb agent-first creation used for its own agent
  // terminal; rows persisted before the rename still carry it.
  return effects.filter(
    (effect) => effect.action?.startsWith('created') || effect.action === 'reused_agent_terminal'
  )
}

type WorkerSetupStageArgs = {
  db: OrchestrationDb
  dispatchId: string
  worktreeId: string
  terminalHandle: string
  setup: WorkerSetupReceipt
  effects: WorkerEffect[]
}

export function persistWorkerReadinessStage(args: WorkerSetupStageArgs): void {
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'terminal_readying',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
}

export function persistGatedSetupSpawnFailure(args: WorkerSetupStageArgs): boolean {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'spawn_failed') {
    return false
  }
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: 'setup_start',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
  return true
}

export function persistWorkerSetupWaitOutcome(
  args: WorkerSetupStageArgs & { wait: { satisfied: boolean; status: string } }
): void {
  applyWaitForSetupOutcome(args.setup, args.effects, args.wait)
  if (args.setup.startupPolicy !== 'wait-for-setup') {
    return
  }
  args.db.recordWorkerStage({
    dispatchId: args.dispatchId,
    stage: args.setup.state === 'failed' ? 'setup_failed' : 'setup_settled',
    worktreeId: args.worktreeId,
    terminalHandle: args.terminalHandle,
    setupState: args.setup.state,
    effects: args.effects,
    residualResources: residualWorkerEffects(args.effects)
  })
}

/** How long a readiness timeout asks the setup terminal whether setup exited. An exited setup
 *  normally answers at once from its replayed completion marker; a running one uses the whole probe. */
const SETUP_EXIT_PROBE_MS = 1_000

export function setupStillRunningError(timeoutMs: number): Error {
  return new Error(
    `Setup was still running after ${timeoutMs} ms (startup policy wait-for-setup), so the agent could not start. Retry with a larger --timeout-ms.`
  )
}

/**
 * Under wait-for-setup the agent cannot start before setup exits, so a terminal readiness timeout
 * asks the setup terminal what setup did. The receipt cannot answer: it still says `running`,
 * because only a readiness wait that returns updates it, and a failed setup leaves the pane's shell
 * alive, so that wait times out too.
 *
 * Returns the setup error to report, or null to keep the agent-readiness timeout: setup exited 0,
 * or there is no setup terminal to ask. An exit it observes is persisted as the setup outcome.
 */
export async function setupErrorAtReadinessTimeout(
  args: WorkerSetupStageArgs & {
    runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>
    timeoutMs: number
  }
): Promise<Error | null> {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'running') {
    return null
  }
  const setupTerminal = args.effects.find((effect) => effect.kind === 'setup')?.terminalId
  if (!setupTerminal) {
    return null
  }
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let completion: { exitCode: number | null } | 'running'
  try {
    completion = await Promise.race([
      args.runtime.waitForSetupTerminalCompletion(setupTerminal, abort.signal),
      new Promise<'running'>((resolve) => {
        timer = setTimeout(() => resolve('running'), SETUP_EXIT_PROBE_MS)
      })
    ])
  } catch {
    // A setup terminal that is already gone gives no evidence either way.
    return null
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
  if (completion === 'running') {
    return setupStillRunningError(args.timeoutMs)
  }
  persistWorkerSetupWaitOutcome({
    ...args,
    wait: { satisfied: completion.exitCode === 0, status: 'exited' }
  })
  if (completion.exitCode === 0) {
    return null
  }
  return new Error(
    `Setup failed (exit ${completion.exitCode ?? 'unknown'}), so the agent could not start (startup policy wait-for-setup).`
  )
}
