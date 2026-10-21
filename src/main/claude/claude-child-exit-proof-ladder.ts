import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import { PROVIDER_SUPERVISOR_MAX_STOP_MS } from '../provider-process/provider-process-supervisor'
import type {
  ProviderProcessClosePolicy,
  ProviderProcessCloseResult
} from '../provider-process/provider-process-close'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

export const GRACEFUL_EXIT_MS = 1_500
// A signalled supervisor escalates on its own; forcing it sooner kills it and orphans Claude.
export const SUPERVISED_GRACEFUL_EXIT_MS = PROVIDER_SUPERVISOR_MAX_STOP_MS + 500
const FORCED_EXIT_MS = 1_000

export function claudeChildClosePolicy(
  supervised: boolean,
  platform: NodeJS.Platform = process.platform
): ProviderProcessClosePolicy {
  return {
    gracefulExitMs: supervised ? SUPERVISED_GRACEFUL_EXIT_MS : GRACEFUL_EXIT_MS,
    forcedExitMs: FORCED_EXIT_MS,
    signalSupervisorOnClose: true,
    // On Windows, as with the Codex close, Claude leaving on its own after its stdin ends is the
    // close: Orca makes no claim about processes Claude started. An exit after any forced reap on
    // this tree, in this close or an earlier one, keeps taskkill's verdict.
    selfExitIsClose: platform === 'win32'
  }
}

/** The root exited, and its tree was seen gone or, on Windows, it left on its own. */
export function claudeChildCloseProven(result: ProviderProcessCloseResult): boolean {
  return result.root === 'exited' && (result.tree === 'exited' || result.selfExit === true)
}

export type ClaudeChildExitProofInput = {
  managed: ManagedProviderProcess
  tree?: ClaudeChildTreeReaper
}

export async function proveClaudeChildExitWithReaper(
  input: ClaudeChildExitProofInput,
  createTree: () => ClaudeChildTreeReaper
): Promise<boolean> {
  return claudeChildCloseProven(await input.managed.close(input.tree ?? createTree()))
}
