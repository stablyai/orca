/** Structured chats have no startup command to sequence after setup, so the start waits on Setup explicitly.
 * No applicable wait needs no receipt; a wait that loses sight of Setup records wait_unevaluated and fails the start. */

import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { WorkerEffect, WorkerSetupReceipt } from '../placement/worker-placement-topology'

export type StructuredWorkerSetupGate = {
  satisfied: boolean
  /** `exited`, `timeout`, or `unobserved` when Orca lost sight of Setup (see `reason`). */
  status: string
  reason?: string
  /** A setup gate has no agent prompt to block on; declared so the wait union stays property-typed. */
  blockedReason?: undefined
}

/** One Setup wait per start: begun once, raced against each budget (the start's own, then the
 *  background's), so a later budget never has to find the setup terminal again. */
export type StructuredWorkerSetupWatch = {
  /** Setup's verdict within `timeoutMs`, a timeout while Setup runs. */
  within: (timeoutMs: number, signal?: AbortSignal) => Promise<StructuredWorkerSetupGate>
  /** Stops watching the setup terminal. */
  dispose: () => void
}

/** Null when no wait applies: no wait-for-setup policy, Setup not running, or no setup terminal. */
export function watchStructuredWorkerSetup(args: {
  runtime: Pick<OrcaRuntimeService, 'waitForSetupTerminalCompletion'>
  setup: WorkerSetupReceipt
  effects: WorkerEffect[]
}): StructuredWorkerSetupWatch | null {
  if (args.setup.startupPolicy !== 'wait-for-setup' || args.setup.state !== 'running') {
    return null
  }
  const setupTerminal = args.effects.find((effect) => effect.kind === 'setup')?.terminalId
  if (!setupTerminal) {
    return null
  }
  const stop = new AbortController()
  const verdict = args.runtime.waitForSetupTerminalCompletion(setupTerminal, stop.signal).then(
    (completion): StructuredWorkerSetupGate => ({
      satisfied: completion.exitCode === 0,
      status: 'exited'
    }),
    (error: unknown): StructuredWorkerSetupGate => {
      const reason = error instanceof Error ? error.message : String(error)
      if (!stop.signal.aborted) {
        // A taken wait that throws loses observation: recorded, and never read as Setup having finished.
        args.effects.push({ kind: 'setup', action: 'wait_unevaluated', state: reason })
      }
      return { satisfied: false, status: 'unobserved', reason }
    }
  )
  return {
    within: (timeoutMs, signal) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let onAbort: (() => void) | undefined
      return Promise.race([
        verdict,
        new Promise<StructuredWorkerSetupGate>((resolve, reject) => {
          timer = setTimeout(() => resolve({ satisfied: false, status: 'timeout' }), timeoutMs)
          onAbort = () => reject(signal?.reason)
          if (signal?.aborted) {
            onAbort()
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        })
      ]).finally(() => {
        clearTimeout(timer)
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort)
        }
      })
    },
    dispose: () => stop.abort()
  }
}
