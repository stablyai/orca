import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { AgentForegroundProcessResolution } from './agent-foreground-process'

export type StableForegroundProcess = {
  /** Foreground process name to report to callers. */
  processName: string | null
  /** Agent name to remember for the next degraded read; null clears the memory. */
  lastRecognizedAgent: string | null
}

/**
 * Keep the reported foreground process stable across a degraded inspection.
 *
 * Why: on Windows/ConPTY the foreground scan (a `Get-CimInstance Win32_Process`
 * PowerShell fork) can exceed its 3s budget under load, and there is no `wmic`
 * fallback on Win11 24H2+. A degraded scan returns `available: false` and falls
 * back to the shell name — which the completion coordinator reads as "the agent
 * exited" and fires a false "agent done" notification while the agent is still
 * working. On a degraded read, prefer the last agent we positively recognized so
 * a transient scan failure never looks like an exit. A completed (`available`)
 * scan is authoritative and refreshes — or clears — that memory, so a genuine
 * exit is still detected.
 */
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
