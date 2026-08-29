import type { IPtyProvider } from './types'

export type PtyProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
}

function unavailablePtyProcessInspection(
  value?: Partial<PtyProcessInspection>
): PtyProcessInspection {
  return {
    foregroundProcess:
      typeof value?.foregroundProcess === 'string' ? value.foregroundProcess : null,
    hasChildProcesses: value?.hasChildProcesses === true,
    unavailable: true
  }
}

export function normalizePtyProcessInspection(value: unknown): PtyProcessInspection {
  if (typeof value !== 'object' || value === null) {
    return unavailablePtyProcessInspection()
  }
  const inspection = value as Partial<PtyProcessInspection>
  const foregroundProcess = inspection.foregroundProcess
  const hasChildProcesses = inspection.hasChildProcesses
  const unavailable = inspection.unavailable
  if (
    (foregroundProcess !== null && typeof foregroundProcess !== 'string') ||
    typeof hasChildProcesses !== 'boolean' ||
    (unavailable !== undefined && unavailable !== true)
  ) {
    return unavailablePtyProcessInspection({ foregroundProcess, hasChildProcesses })
  }
  return {
    foregroundProcess,
    hasChildProcesses,
    ...(unavailable === true ? { unavailable: true } : {})
  }
}

export async function inspectPtyProviderProcess(
  provider: IPtyProvider,
  ptyId: string
): Promise<PtyProcessInspection> {
  if (provider.hasPty?.(ptyId) === false) {
    throw new Error('terminal_gone')
  }
  if (typeof provider.inspectProcess !== 'function') {
    return unavailablePtyProcessInspection()
  }
  return normalizePtyProcessInspection(await provider.inspectProcess(ptyId))
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
