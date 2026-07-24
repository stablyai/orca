import type { IPtyProvider } from './types'

export type PtyProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
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
