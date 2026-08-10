import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostScope,
  parseExecutionHostId
} from '../../shared/execution-host'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'
import { parseAiVaultSessionTitlesResult } from '../ai-vault/session-title-result-validation'
import { requestActiveSshAiVaultSessionTitles } from './ssh'

export type RuntimeAiVaultSessionTitleResolver = (
  environmentId: string,
  args: AiVaultSessionTitlesArgs
) => Promise<AiVaultSessionTitlesResult>

export async function resolveAiVaultSessionTitlesByHost(
  args: AiVaultSessionTitlesArgs,
  resolveRuntime?: RuntimeAiVaultSessionTitleResolver
): Promise<AiVaultSessionTitlesResult> {
  const executionHostScope = normalizeExecutionHostScope(
    args.executionHostScope ?? LOCAL_EXECUTION_HOST_ID
  )
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return resolveLocalAiVaultSessionTitles(args.requests)
  }
  const parsed = parseExecutionHostId(executionHostScope)
  if (parsed?.kind === 'ssh') {
    try {
      const result = await requestActiveSshAiVaultSessionTitles(parsed.targetId, {
        requests: args.requests
      })
      return result === null ? { titles: [] } : parseAiVaultSessionTitlesResult(result)
    } catch {
      return { titles: [] }
    }
  }
  if (parsed?.kind === 'runtime' && resolveRuntime) {
    return resolveRuntime(parsed.environmentId, args).catch(() => ({ titles: [] }))
  }
  return { titles: [] }
}
