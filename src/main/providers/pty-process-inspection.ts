import type { IPtyProvider } from './types'
import {
  buildAbsentPtyInspection,
  type PtyProcessInspectionEvidence
} from '../../shared/pty-process-inspection-evidence'

export type PtyProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
  // Why optional: hosts that predate the evidence contract omit it; readers
  // fall back to the legacy fields (see readPtyProcessInspectionEvidence).
  processEvidence?: PtyProcessInspectionEvidence
}

/**
 * A PTY the provider has no handle for. `absence` carries what that proves:
 * `exited` only when the provider watched the process go, `unverifiable` when it
 * merely lost the route (docs/reference/ssh-execution-boundary.md). The message
 * stays `terminal_gone` because every existing catcher matches on that string.
 */
export class PtyGoneError extends Error {
  constructor(readonly absence: 'exited' | 'unverifiable') {
    super('terminal_gone')
    this.name = 'PtyGoneError'
  }
}

type CompletionSensitivePtyProvider = IPtyProvider & {
  inspectProcess?: (id: string) => Promise<PtyProcessInspection>
}

export async function inspectPtyProviderProcess(
  provider: IPtyProvider,
  ptyId: string
): Promise<PtyProcessInspection> {
  if (provider.hasPty?.(ptyId) === false) {
    throw new PtyGoneError(provider.ptyAbsenceVerdict?.(ptyId) ?? 'unverifiable')
  }
  const inspectProcess = (provider as CompletionSensitivePtyProvider).inspectProcess
  if (inspectProcess) {
    return inspectProcess.call(provider, ptyId)
  }
  const foregroundProcess = await provider.getForegroundProcess(ptyId)
  const hasChildProcesses = await provider.hasChildProcesses(ptyId)
  return { foregroundProcess, hasChildProcesses }
}

export async function inspectPtyProviderProcessForRenderer(
  provider: IPtyProvider,
  ptyId: string
): Promise<PtyProcessInspection> {
  try {
    return await inspectPtyProviderProcess(provider, ptyId)
  } catch (error) {
    if (error instanceof PtyGoneError) {
      return buildAbsentPtyInspection(error.absence)
    }
    // Why unverifiable: an untyped terminal_gone came from a provider that never
    // stated what its absence proves, and that is not evidence of an exit.
    if (error instanceof Error && error.message === 'terminal_gone') {
      return buildAbsentPtyInspection('unverifiable')
    }
    throw error
  }
}
