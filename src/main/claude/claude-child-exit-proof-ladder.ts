import type { ManagedProviderProcess } from '../provider-process/managed-provider-process'
import type {
  ProviderProcessClosePolicy,
  ProviderProcessCloseResult
} from '../provider-process/provider-process-close'
import type { ClaudeChildTreeReaper } from './claude-agent-sdk-exit-proof'

export const GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000

export function claudeChildClosePolicy(
  _dedicatedGroup: boolean,
  platform: NodeJS.Platform = process.platform
): ProviderProcessClosePolicy {
  return {
    gracefulExitMs: GRACEFUL_EXIT_MS,
    forcedExitMs: FORCED_EXIT_MS,
    immediateTerm: true,
    // Windows accepts voluntary exit after stdin ends; any forced reap retains taskkill's verdict.
    selfExitIsClose: platform === 'win32'
  }
}

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
