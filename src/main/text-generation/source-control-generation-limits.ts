import type { TextGenerationOperation } from './source-control-text-generation-types'

export const SOURCE_CONTROL_GENERATION_TIMEOUT_MS = 60_000
// Why: nobody waits on background naming, and agent CLIs that connect every configured
// MCP server before answering (Cursor stalls ~60s on unreachable ones) overrun 60s.
export const BACKGROUND_NAME_GENERATION_TIMEOUT_MS = 180_000
export const MAX_SOURCE_CONTROL_AGENT_OUTPUT_BYTES = 4 * 1024 * 1024

export function sourceControlGenerationTimeoutMs(operation: TextGenerationOperation): number {
  return operation === 'branch-name' || operation === 'conversation-name'
    ? BACKGROUND_NAME_GENERATION_TIMEOUT_MS
    : SOURCE_CONTROL_GENERATION_TIMEOUT_MS
}

export function generationTimedOutError(agentLabel: string, timeoutMs: number): string {
  return `${agentLabel} did not finish within ${timeoutMs / 1000}s. Its CLI may be stuck starting up, for example connecting to unreachable MCP servers. Run it in a terminal to check, or choose another agent in Settings.`
}
