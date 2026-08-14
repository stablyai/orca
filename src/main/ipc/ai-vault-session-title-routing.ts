import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import {
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  requestedExecutionHostScope
} from '../../shared/execution-host'
import type { RuntimeOwnedSshAiVaultHost } from '../ai-vault/runtime-owned-ssh-session-list'
import { resolveLocalAiVaultSessionTitles } from '../ai-vault/session-title-resolver'
import { parseAiVaultSessionTitlesResult } from '../ai-vault/session-title-result-validation'
import { getActiveSshAiVaultHostInfo, requestActiveSshAiVaultSessionTitles } from './ssh'

export type RuntimeAiVaultSessionTitleResolver = (
  environmentId: string,
  args: AiVaultSessionTitlesArgs
) => Promise<AiVaultSessionTitlesResult>

export type RuntimeOwnedSshAiVaultSessionTitleResolver = (
  environmentId: string,
  targetId: string,
  args: AiVaultSessionTitlesArgs
) => Promise<AiVaultSessionTitlesResult>

export async function resolveAiVaultSessionTitlesByHost(
  args: AiVaultSessionTitlesArgs,
  options: {
    resolveRuntime?: RuntimeAiVaultSessionTitleResolver
    findRuntimeOwningSshAiVaultHost?: (
      targetId: string
    ) => Promise<RuntimeOwnedSshAiVaultHost | null>
    resolveRuntimeOwnedSsh?: RuntimeOwnedSshAiVaultSessionTitleResolver
  } = {}
): Promise<AiVaultSessionTitlesResult> {
  const executionHostScope = requestedExecutionHostScope(args.executionHostScope)
  if (executionHostScope === LOCAL_EXECUTION_HOST_ID) {
    return resolveLocalAiVaultSessionTitles(args.requests)
  }
  const parsed = parseExecutionHostId(executionHostScope)
  if (parsed?.kind === 'ssh') {
    return resolveSshAiVaultSessionTitles(parsed.targetId, args, options)
  }
  if (parsed?.kind === 'runtime' && options.resolveRuntime) {
    return options.resolveRuntime(parsed.environmentId, args).catch(() => ({ titles: [] }))
  }
  return { titles: [] }
}

async function resolveSshAiVaultSessionTitles(
  targetId: string,
  args: AiVaultSessionTitlesArgs,
  options: {
    findRuntimeOwningSshAiVaultHost?: (
      targetId: string
    ) => Promise<RuntimeOwnedSshAiVaultHost | null>
    resolveRuntimeOwnedSsh?: RuntimeOwnedSshAiVaultSessionTitleResolver
  }
): Promise<AiVaultSessionTitlesResult> {
  try {
    const result = await requestActiveSshAiVaultSessionTitles(targetId, {
      requests: args.requests
    })
    if (result !== null) {
      return parseAiVaultSessionTitlesResult(result)
    }
  } catch {
    // Fall through to the owning runtime when this process does not hold the SSH session.
  }
  if (
    isRuntimeOwnedSshTargetId(targetId) ||
    getActiveSshAiVaultHostInfo(targetId) ||
    !options.findRuntimeOwningSshAiVaultHost ||
    !options.resolveRuntimeOwnedSsh
  ) {
    return { titles: [] }
  }
  const owner = await options.findRuntimeOwningSshAiVaultHost(targetId)
  if (!owner) {
    return { titles: [] }
  }
  return options.resolveRuntimeOwnedSsh(owner.environmentId, owner.targetId, args)
}
