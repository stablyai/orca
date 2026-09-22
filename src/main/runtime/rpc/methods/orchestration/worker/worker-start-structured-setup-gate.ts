/**
 * The `wait-for-setup` gate for a structured worker on a worktree this start created.
 *
 * A PTY worker gets the gate for free: agent-first creation sequences the agent's startup command
 * behind the setup runner, so `tui-idle` cannot arrive until setup exits, and the worker start
 * reads the gate's outcome off that wait. A structured session has no startup command to sequence,
 * so without this the worker would take its dispatch preamble while `install` was still running,
 * and the repo's wait-for-setup policy would record no evidence at all.
 *
 * Bounded by the start's own timeout, and deliberately forgiving: a wait that cannot be taken —
 * an in-process hook with no setup terminal, or a setup pty already gone — yields no verdict
 * rather than a failure, because a worker start must not fail on missing evidence.
 *
 * "No verdict" is never silent, though. A wait that could not be TAKEN is an absent precondition
 * and needs no receipt; a wait that was taken and then threw is a LOST observation, and that one
 * is recorded as a `wait_unevaluated` effect so the start's receipt still says the gate went
 * unevaluated and why.
 */

import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { WorkerEffect, WorkerSetupReceipt } from './worker-topology'

export type StructuredWorkerSetupGate = {
  satisfied: boolean
  status: string
  /** A setup gate has no agent prompt to block on; declared so the wait union stays property-typed. */
  blockedReason?: undefined
}

export async function awaitStructuredWorkerSetupGate(args: {
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>
  setup: WorkerSetupReceipt
  effects: WorkerEffect[]
  timeoutMs: number
}): Promise<StructuredWorkerSetupGate | null> {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'running') {
    return null
  }
  const setupTerminal = args.effects.find((effect) => effect.kind === 'setup')?.terminalId
  if (!setupTerminal) {
    return null
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      args.runtime.waitForSetupTerminalCompletion(setupTerminal).then((completion) => ({
        satisfied: completion.exitCode === 0,
        status: 'exited'
      })),
      new Promise<StructuredWorkerSetupGate>((resolve) => {
        timer = setTimeout(() => resolve({ satisfied: false, status: 'timeout' }), args.timeoutMs)
      })
    ])
  } catch (error) {
    // A wait that was TAKEN and then threw is not the same as one that could not be taken. Both
    // yield no verdict — a start must not fail on missing evidence — but only this one is a lost
    // observation, so it is recorded rather than silently flattened into "not applicable".
    args.effects.push({
      kind: 'setup',
      action: 'wait_unevaluated',
      state: error instanceof Error ? error.message : String(error)
    })
    return null
  } finally {
    clearTimeout(timer)
  }
}
