import type * as pty from 'node-pty'
import { recognizeAgentProcess } from '../../../shared/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundProcess } from '../../../shared/foreground-wrapper-agent'
import {
  inspectAgentPtyProcess,
  resolveAgentForegroundProcessWithAvailability
} from '../../providers/agent-foreground-process'
import { readWindowsConsoleAttachedProcessIds } from '../../providers/windows-console-attached-processes'
import { readWindowsPtyJobProcessIds } from '../../providers/windows-pty-job-membership'

type ForegroundInspectionArgs = {
  process: pty.IPty
  contextPaths: readonly string[]
  isDead: () => boolean
  getFallbackProcess: () => string | null
  shouldInspectFallback: (fallbackProcess: string | null) => boolean
  cachedAgentName: () => string | null
  setRecognizedAgent: (processName: string, processId: number | null) => void
  clearAgentEvidence: () => void
}

export async function inspectTrackedForegroundProcess(
  args: ForegroundInspectionArgs
): Promise<{ processName: string | null; available: boolean }> {
  const proc = args.process
  if (args.isDead() || !proc.pid) {
    return { processName: null, available: false }
  }
  try {
    const fallbackProcess = args.getFallbackProcess()
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (
      fallbackProcess &&
      ((fallbackRecognition !== null &&
        process.platform !== 'win32' &&
        !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
        (process.platform !== 'win32' && !args.shouldInspectFallback(fallbackProcess)))
    ) {
      return { processName: fallbackProcess, available: true }
    }
    const resolution = await resolveAgentForegroundProcessWithAvailability(
      proc.pid,
      fallbackProcess,
      {
        contextPaths: args.contextPaths,
        fresh: true,
        ...(process.platform === 'win32'
          ? {
              forceProcessScan: true,
              readWindowsConsoleAttachedProcessIds: () =>
                readWindowsConsoleAttachedProcessIds(proc.pid)
            }
          : {})
      }
    )
    if (args.isDead() || !resolution.available) {
      return { processName: args.cachedAgentName() ?? fallbackProcess, available: false }
    }
    const recognized = recognizeAgentProcess(resolution.processName)
    if (recognized) {
      args.setRecognizedAgent(recognized.processName, resolution.processId ?? null)
      return { processName: recognized.processName, available: true }
    }
    args.clearAgentEvidence()
    return { processName: resolution.processName, available: true }
  } catch {
    return { processName: args.cachedAgentName(), available: false }
  }
}

export async function inspectTrackedPtyProcess(args: ForegroundInspectionArgs): Promise<{
  foregroundProcess: string | null
  hasChildProcesses: boolean
  unavailable?: true
}> {
  const proc = args.process
  if (args.isDead() || !proc.pid) {
    return { foregroundProcess: null, hasChildProcesses: false, unavailable: true }
  }
  const inspection = await inspectAgentPtyProcess(proc.pid, args.getFallbackProcess(), {
    contextPaths: args.contextPaths,
    forceProcessScan: true,
    ...(process.platform === 'win32'
      ? {
          readWindowsConsoleAttachedProcessIds: () =>
            readWindowsConsoleAttachedProcessIds(proc.pid),
          readWindowsPtyJobProcessIds: () => readWindowsPtyJobProcessIds(proc)
        }
      : {})
  })
  if (inspection.available) {
    const recognized = recognizeAgentProcess(inspection.processName)
    if (recognized) {
      args.setRecognizedAgent(recognized.processName, inspection.processId ?? null)
    } else {
      args.clearAgentEvidence()
    }
  }
  return {
    foregroundProcess: inspection.processName,
    hasChildProcesses: inspection.hasChildProcesses,
    ...(inspection.available ? {} : { unavailable: true })
  }
}
