import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  requestedExecutionHostScope
} from '../../shared/execution-host'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'
import { parseAiVaultSessionTitlesResult } from '../ai-vault/session-title-result-validation'
import { requestActiveSshAiVaultSessionTitles } from './ssh'
import {
  showLaunchPromptsInSessionTitles,
  withoutPaneKey
} from '../ai-vault/session-title-launch-prompt'

export type RuntimeAiVaultSessionTitleResolver = (
  environmentId: string,
  args: AiVaultSessionTitlesArgs
) => Promise<AiVaultSessionTitlesResult>

export async function resolveAiVaultSessionTitlesByHost(
  args: AiVaultSessionTitlesArgs,
  resolveRuntime?: RuntimeAiVaultSessionTitleResolver
): Promise<AiVaultSessionTitlesResult> {
  // Why here: this host spawned the panes it shows, local and SSH alike, so it kept their prompts.
  return showLaunchPromptsInSessionTitles(
    args.requests,
    await resolveTitlesOnHost(args, resolveRuntime)
  )
}

async function resolveTitlesOnHost(
  args: AiVaultSessionTitlesArgs,
  resolveRuntime?: RuntimeAiVaultSessionTitleResolver
): Promise<AiVaultSessionTitlesResult> {
  const executionHostScope = requestedExecutionHostScope(args.executionHostScope)
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return resolveLocalAiVaultSessionTitles(args.requests)
  }
  const parsed = parseExecutionHostId(executionHostScope)
  if (parsed?.kind === 'ssh') {
    try {
      const result = await requestActiveSshAiVaultSessionTitles(parsed.targetId, {
        requests: args.requests.map(withoutPaneKey)
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
