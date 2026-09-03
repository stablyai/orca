import type { IPtyProvider } from './types'
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
    options?: { expectedIncarnationId?: PtyIncarnationId }
  ) => Promise<PtyProcessInspection>
}

export async function inspectPtyProviderProcess(
  provider: IPtyProvider,
  ptyId: string,
  options?: { expectedIncarnationId?: PtyIncarnationId }
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
  options?: { expectedIncarnationId?: PtyIncarnationId }
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
