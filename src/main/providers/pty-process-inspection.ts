import type { IPtyProvider } from './types'
import type { PtyProcessInspectionEvidence } from '../../shared/pty-process-inspection-evidence'

export type PtyProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
  // Why optional: hosts that predate the evidence contract omit it; readers
  // fall back to the legacy fields (see readPtyProcessInspectionEvidence).
  processEvidence?: PtyProcessInspectionEvidence
}

type CompletionSensitivePtyProvider = IPtyProvider & {
  inspectProcess?: (id: string) => Promise<PtyProcessInspection>
}

export async function inspectPtyProviderProcess(
  provider: IPtyProvider,
  ptyId: string
): Promise<PtyProcessInspection> {
  if (provider.hasPty?.(ptyId) === false) {
    throw new Error('terminal_gone')
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
    if (error instanceof Error && error.message === 'terminal_gone') {
      return { foregroundProcess: null, hasChildProcesses: false, unavailable: true }
    }
    throw error
  }
}
