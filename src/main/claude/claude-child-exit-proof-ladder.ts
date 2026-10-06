import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import type { ProviderProcessClosePolicy } from '../provider-process/provider-process-close'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

export const GRACEFUL_EXIT_MS = 1_500
// A signalled supervisor escalates on its own; forcing it sooner kills it and orphans Claude.
export const SUPERVISED_GRACEFUL_EXIT_MS = PROVIDER_SUPERVISOR_MAX_STOP_MS + 500
const FORCED_EXIT_MS = 1_000

export function claudeChildClosePolicy(supervised: boolean): ProviderProcessClosePolicy {
  return {
    gracefulExitMs: supervised ? SUPERVISED_GRACEFUL_EXIT_MS : GRACEFUL_EXIT_MS,
    forcedExitMs: FORCED_EXIT_MS,
    signalSupervisorOnClose: true
  }
}

export type ClaudeChildExitProofInput = {
  managed: ManagedProviderProcess
  tree?: ClaudeChildTreeReaper
}

export async function proveClaudeChildExitWithReaper(
  input: ClaudeChildExitProofInput,
  createTree: () => ClaudeChildTreeReaper
): Promise<boolean> {
  const result = await input.managed.close(input.tree ?? createTree())
  return result.root === 'exited' && result.tree === 'exited'
}
