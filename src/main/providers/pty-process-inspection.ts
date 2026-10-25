import type { IPtyProvider } from './pty-provider-contract'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import {
  classifyTerminalProcessInspectionFailure,
  clientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from '../../shared/terminal-process-inspection'

export type PtyProcessInspection = TerminalProcessInspection

type CompletionSensitivePtyProvider = IPtyProvider & {
  inspectProcess?: (
    id: string,
    options?: PtyProcessInspectionOptions
  ) => Promise<PtyProcessInspection>
}

/** scanChildProcesses requests decision-time evidence; steady polls may rely on the next tick to correct stale reads. */
export type PtyProcessInspectionOptions = {
  expectedIncarnationId?: PtyIncarnationId
  scanChildProcesses?: boolean
  /** Adoption only: ignore members outside both shell ancestry and console; close still reaches the whole job. */
  ignoreDetached?: boolean
  /** Name-only cadence polls may use cheap captures and omit evidence; evidence consumers must never set this. */
  steadyState?: boolean
}

export async function inspectPtyProviderProcess(
  provider: IPtyProvider,
  ptyId: string,
  options?: PtyProcessInspectionOptions
): Promise<PtyProcessInspection> {
  if (provider.hasPty?.(ptyId) === false) {
    throw new Error('terminal_gone')
  }
  const inspectProcess = (provider as CompletionSensitivePtyProvider).inspectProcess
  if (inspectProcess) {
    return options
      ? inspectProcess.call(provider, ptyId, options)
      : inspectProcess.call(provider, ptyId)
  }
  const foregroundProcess = await provider.getForegroundProcess(ptyId)
  const hasChildProcesses = await provider.hasChildProcesses(ptyId)
  return { foregroundProcess, hasChildProcesses }
}

export async function inspectPtyProviderProcessForRenderer(
  provider: IPtyProvider,
  ptyId: string,
  options?: PtyProcessInspectionOptions
): Promise<PtyProcessInspection> {
  try {
    return await inspectPtyProviderProcess(provider, ptyId, options)
  } catch (error) {
    const reason = classifyTerminalProcessInspectionFailure(error)
    if (reason) {
      return clientOnlyUnverifiableInspection(reason)
    }
    throw error
  }
}
