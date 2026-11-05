import { resolveHostAgentBaseEnvironment } from '../runtime/structured-agent-shell-environment'
import type { CommitMessageAgentEnvironmentResolvers } from './commit-message-agent-environment'
import { createOpenCodeTextSubscriptionPreparation } from './opencode-text-subscriptions'
import { createClaudeTextSubscriptionPreparation } from './claude-text-subscriptions'
import { createCodexTextSubscriptionPreparation } from './codex-text-subscriptions'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control-ai'
import type { TextGenerationRequest } from './source-control-generation-lanes'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'

export type TextSubscriptionAttempt = {
  accountId: string
  identity: string
  model: string
  env: NodeJS.ProcessEnv
  spawnAllowed?: () => boolean
  configurePlan: (plan: CommitMessagePlan) => CommitMessagePlan
  valid: () => boolean | Promise<boolean>
}

export type TextSubscriptionFailover = {
  current: () => boolean
  params: Readonly<ResolvedSourceControlAiGenerationParams>
  initialAccountId: string
  prepare: (accountId: string) => Promise<TextSubscriptionAttempt | null>
  candidates: () => string[] | Promise<string[]>
  confirmQuota?: (attempt: TextSubscriptionAttempt) => Promise<boolean>
  fallbackEnvironment?: () => Promise<NodeJS.ProcessEnv | undefined>
}

export type PrepareTextSubscriptionFailover = (input: {
  params: ResolvedSourceControlAiGenerationParams
  cwd: string
  env: NodeJS.ProcessEnv
  request: TextGenerationRequest
}) => TextSubscriptionFailover | undefined

function createTextSubscriptionPreparation(
  deps: Parameters<typeof createClaudeTextSubscriptionPreparation>[0] & {
    home: Parameters<typeof createCodexTextSubscriptionPreparation>[0]['home']
    rateLimits: Parameters<typeof createOpenCodeTextSubscriptionPreparation>[0]['rateLimits']
  }
): PrepareTextSubscriptionFailover {
  const claude = createClaudeTextSubscriptionPreparation(deps)
  const codex = createCodexTextSubscriptionPreparation(deps)
  const opencode = createOpenCodeTextSubscriptionPreparation(deps)
  return (input) =>
    input.params.agentId === 'claude'
      ? claude(input)
      : input.params.agentId === 'codex'
        ? codex(input)
        : opencode(input)
}

export function hostTextSubscriptionResolvers(
  deps: Parameters<typeof createTextSubscriptionPreparation>[0]
): Required<
  Pick<
    CommitMessageAgentEnvironmentResolvers,
    'prepareTextSubscriptionFailover' | 'resolveBaseEnvironment'
  >
> {
  return {
    prepareTextSubscriptionFailover: createTextSubscriptionPreparation(deps),
    resolveBaseEnvironment: () => resolveHostAgentBaseEnvironment(deps.store.getSettings())
  }
}
