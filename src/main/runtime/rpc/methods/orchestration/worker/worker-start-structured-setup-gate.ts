/** Structured chats have no startup command to sequence after setup, so wait explicitly within the start deadline.
 * Missing evidence never fails start: unavailable waits need no receipt; attempted waits that throw record wait_unevaluated. */

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
    // A taken wait that throws loses observation; record wait_unevaluated instead of conflating it with no applicable wait.
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
