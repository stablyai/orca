import type { IPtyProvider } from './types'
import {
  buildPtyProcessInspectionWireResult,
  type PtyProcessInspectionEvidence
} from '../../shared/pty-process-inspection-evidence'
import { isShellProcess } from '../../shared/shell-process-detection'

export type PtyProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
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
  // A local exit can land after the initial hasPty check but before the
  // foreground probe resolves. Keep that half explicitly unverifiable rather
  // than letting its null collapse look like an observed idle shell.
  const foregroundStillPresent = provider.hasPty?.(ptyId) !== false
  const hasChildProcesses = await provider.hasChildProcesses(ptyId)
  return buildPtyProcessInspectionWireResult(
    foregroundStillPresent
      ? foregroundProcess && !isShellProcess(foregroundProcess)
        ? { verdict: 'live', processName: foregroundProcess }
        : { verdict: 'exited', processName: foregroundProcess }
      : { verdict: 'unverifiable', reason: 'pty exited during foreground inspection' },
    hasChildProcesses ? { verdict: 'live' } : { verdict: 'exited' }
  )
}

export async function inspectPtyProviderProcessForRenderer(
  provider: IPtyProvider,
  ptyId: string
): Promise<PtyProcessInspection> {
  try {
    return await inspectPtyProviderProcess(provider, ptyId)
  } catch (error) {
    if (error instanceof Error && error.message === 'terminal_gone') {
      return {
        foregroundProcess: null,
        hasChildProcesses: false,
        unavailable: true,
        processEvidence: {
          foreground: { verdict: 'unverifiable', reason: 'pty no longer exists' },
          children: { verdict: 'unverifiable', reason: 'pty no longer exists' }
        }
      }
    }
    throw error
  }
}
