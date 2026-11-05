import type { TextGenerationOperation } from '../text-generation/source-control-text-generation-types'
import type { TextSubscriptionFailover } from '../text-generation/text-subscription-failover'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { beginTextGenerationRequest } from '../text-generation/source-control-generation-lanes'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../text-generation/source-control-generation-limits'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type { CommitMessageGenerationTarget } from '../text-generation/commit-message-text-generation'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'

type GenerationTargetDeps = {
  getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
}

type GenerationTargetOptions = {
  operation?: TextGenerationOperation
  params: ResolvedSourceControlAiGenerationParams
  current: () => boolean
  validate?: () => Promise<boolean>
  ownerId?: string
  canFailover?: boolean
}

/** Null when the agent environment cannot be prepared; callers that surface the cause use the result variant. */
export async function resolveGenerationTarget(
  worktreePath: string,
  agentId: string,
  deps: GenerationTargetDeps,
  options?: GenerationTargetOptions
): Promise<CommitMessageGenerationTarget | null> {
  const resolved = await resolveGenerationTargetResult(worktreePath, agentId, deps, options)
  return resolved.ok ? resolved.target : null
}

export async function resolveGenerationTargetResult(
  worktreePath: string,
  agentId: string,
  deps: GenerationTargetDeps,
  options?: GenerationTargetOptions
): Promise<{ ok: true; target: CommitMessageGenerationTarget } | { ok: false; error: string }> {
  const resolvers = deps.getAgentEnvResolvers()
  const wsl = parseWslUncPath(worktreePath)
  const runtimeTarget = wsl ? { runtime: 'wsl' as const, wslDistro: wsl.distro } : undefined
  let capturedResolvers = resolvers
  if (
    options &&
    options.canFailover !== false &&
    resolvers?.prepareTextSubscriptionFailover &&
    resolvers.resolveBaseEnvironment
  ) {
    // Registered before async preparation so the budget covers it; discarded unless failover applies.
    const request = beginTextGenerationRequest(
      options.operation ?? 'branch-name',
      worktreePath,
      SOURCE_CONTROL_GENERATION_TIMEOUT_MS,
      options.current,
      options.validate,
      options.ownerId
    )
    let env: Record<string, string> | undefined
    try {
      env = { ...(await resolvers.resolveBaseEnvironment()) }
    } catch {
      env = undefined
    }
    let subscription: TextSubscriptionFailover | undefined
    if (env) {
      const baseEnv = env
      capturedResolvers = { ...resolvers, resolveBaseEnvironment: async () => baseEnv }
      try {
        subscription = resolvers.prepareTextSubscriptionFailover({
          params: options.params,
          cwd: worktreePath,
          env,
          request
        })
      } catch {
        subscription = undefined
      }
    }
    if (subscription && env) {
      const ordinaryResolvers = capturedResolvers
      const target: CommitMessageGenerationTarget = {
        kind: 'local',
        cwd: worktreePath,
        ...(wsl ? { wslDistro: wsl.distro } : {}),
        env,
        request,
        subscription: {
          ...subscription,
          fallbackEnvironment: async () => {
            const ordinary = await prepareLocalCommitMessageAgentEnv(
              agentId,
              ordinaryResolvers,
              runtimeTarget
            )
            if (!ordinary.ok) {
              throw new Error(ordinary.error)
            }
            return ordinary.env
          }
        }
      }
      return { ok: true, target }
    }
    request.finish()
  }
  const localEnv = await prepareLocalCommitMessageAgentEnv(
    agentId,
    capturedResolvers,
    runtimeTarget
  ).catch(() => ({ ok: false as const, error: 'Could not prepare the generation environment.' }))
  if (!localEnv.ok) {
    return localEnv
  }
  return {
    ok: true,
    target: {
      ...(wsl ? { wslDistro: wsl.distro } : {}),
      kind: 'local',
      cwd: worktreePath,
      ...(localEnv.env ? { env: localEnv.env } : {})
    }
  }
}
