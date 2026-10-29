import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { AgentForegroundProcessResolution } from './agent-foreground-process'

export type StableForegroundProcess = {
  processName: string | null
  /** Agent name to remember for the next degraded read; null clears the memory. */
  lastRecognizedAgent: string | null
}

/** Degraded scans cannot prove agent exit; preserve recognized identity until an available scan refreshes or clears it. */
export function resolveStableForegroundProcess(
  resolution: AgentForegroundProcessResolution,
  lastRecognizedAgent: string | null
): StableForegroundProcess {
  if (resolution.available) {
    const isAgent =
      resolution.processName !== null && recognizeAgentProcess(resolution.processName) !== null
    return {
      processName: resolution.processName,
      lastRecognizedAgent: isAgent ? resolution.processName : null
    }
  }
  return {
    processName: lastRecognizedAgent ?? resolution.processName,
    lastRecognizedAgent
  }
}
