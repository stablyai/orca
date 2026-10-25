import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseRoutableExecutionHostId,
  requestedExecutionHostScope
} from '../../shared/execution-host'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'

export type RuntimeAiVaultSessionTitleResolver = (
  environmentId: string,
  args: AiVaultSessionTitlesArgs
) => Promise<AiVaultSessionTitlesResult>

export async function resolveAiVaultSessionTitlesByHost(
  args: AiVaultSessionTitlesArgs,
  resolveRuntime?: RuntimeAiVaultSessionTitleResolver
): Promise<AiVaultSessionTitlesResult> {
  const executionHostScope = requestedExecutionHostScope(args.executionHostScope)
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return resolveLocalAiVaultSessionTitles(args.requests)
  }
  const parsed = parseRoutableExecutionHostId(executionHostScope)
  if (parsed?.kind === 'runtime' && resolveRuntime) {
    return resolveRuntime(parsed.environmentId, args).catch(() => ({ titles: [] }))
  }
  return { titles: [] }
}
