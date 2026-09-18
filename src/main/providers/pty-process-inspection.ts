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
    options?: PtyProcessInspectionOptions
  ) => Promise<PtyProcessInspection>
}

/**
 * `scanChildProcesses` marks a read whose answer decides something once, rather than a poll that
 * self-corrects on its next tick. Only hosts where the child answer costs a process-table read
 * act on it; everywhere else the answer was already captured.
 */
export type PtyProcessInspectionOptions = {
  expectedIncarnationId?: PtyIncarnationId
  scanChildProcesses?: boolean
  /** A self-correcting cadence poll that reads only the process name: licenses a host to answer
   *  from a cheap capture and OMIT evidence. Never set by a caller that consumes evidence. */
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

/**
 * Whether the execution host reports that THIS remembered incarnation exited.
 *
 * Deliberately skips the `hasPty` precheck above: that is this process's cache of what it last
 * saw, so it answers `terminal_gone` for exactly the ids a caller asks about here — the ones whose
 * death it was disconnected for. Only the host that watched the process end may say `exited`, and
 * only for the incarnation the caller stored (docs/reference/ssh-execution-boundary.md).
 */
export async function providerObservedIncarnationExit(
  provider: IPtyProvider,
  ptyId: string,
  incarnationId: PtyIncarnationId
): Promise<boolean> {
  const inspectProcess = (provider as CompletionSensitivePtyProvider).inspectProcess
  if (!inspectProcess) {
    return false
  }
  const inspection = await inspectProcess.call(provider, ptyId, {
    expectedIncarnationId: incarnationId
  })
  const evidence = inspection.foregroundProcessEvidence
  return evidence?.verdict === 'exited' && evidence.ptyIncarnationId === incarnationId
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
