/** Structured chats require confirmed setup completion within the start deadline before task delivery. */

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
    return { satisfied: false, status: 'unverifiable' }
  }
  const abort = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      args.runtime
        .waitForSetupTerminalCompletion(setupTerminal, abort.signal)
        .then((completion) => ({
          satisfied: completion.exitCode === 0,
          status: completion.exitCode === null ? 'unverifiable' : 'exited'
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
    return { satisfied: false, status: 'unverifiable' }
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}
