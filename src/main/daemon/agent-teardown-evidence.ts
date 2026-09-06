import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { TuiAgent } from '../../shared/tui-agent'

/** Teardown must sweep descendants: agent-launched, or a recognized agent live in the
 *  foreground — a hand-typed `claude` (bare, or under a wrapper the foreground tracker
 *  resolved) leaks the same detached MCP children as a launched one. */
export function hasAgentTeardownEvidence(
  launchAgent: TuiAgent | null | undefined,
  subprocess: { getForegroundProcess(): string | null }
): boolean {
  return Boolean(launchAgent) || recognizeAgentProcess(subprocess.getForegroundProcess()) !== null
}
