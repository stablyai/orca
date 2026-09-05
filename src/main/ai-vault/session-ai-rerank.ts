import { homedir } from 'node:os'
import { getCommitMessageModelDiscoveryHostKey } from '../../shared/commit-message-host-key'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import {
  buildAiVaultRerankPrompt,
  parseAiVaultRerankOutput,
  type AiVaultRankSessionsArgs,
  type AiVaultRankSessionsResult
} from '../../shared/ai-vault-session-ai-query'
import { getSshGitProvider } from '../providers/ssh-git-dispatch'
import type { CommitMessageGenerationTarget } from '../text-generation/commit-message-text-generation'
import {
  generateTextFromPrompt,
  resolveBranchNameGenerationParams
} from '../text-generation/commit-message-text-generation'
import { parseWslPath } from '../wsl'

export type AiVaultSessionSearchRepo = Pick<Repo, 'path' | 'sourceControlAi' | 'connectionId'>

export type AiVaultSessionSearchTargetContext = {
  wslDistro?: string
}

export function resolveAiVaultSessionSearchGenerationParams(
  settings: GlobalSettings,
  repo?: Pick<Repo, 'sourceControlAi' | 'connectionId'> | null
): ReturnType<typeof resolveBranchNameGenerationParams> {
  const hostKey = getCommitMessageModelDiscoveryHostKey(repo?.connectionId ?? null)
  // Why: Session History AI search must use the same branchName resolver as
  // auto-rename (`resolveBranchNameGenerationParams`), including repo overrides.
  return resolveBranchNameGenerationParams(settings, hostKey, repo)
}

export function resolveAiVaultSessionSearchGenerationTarget(
  repo?: AiVaultSessionSearchRepo | null,
  context: AiVaultSessionSearchTargetContext = {}
): CommitMessageGenerationTarget | null {
  const cwd = repo?.path ?? homedir()
  if (repo?.connectionId) {
    const provider = getSshGitProvider(repo.connectionId)
    if (!provider) {
      // Why: SSH-scoped settings must not run against a local cwd that is a
      // remote path when the SSH provider is gone.
      return null
    }
    return {
      kind: 'remote',
      cwd,
      execute: (plan, planCwd, timeoutMs, operation) =>
        provider.executeCommitMessagePlan(plan, planCwd, timeoutMs, operation),
      missingBinaryLocation: 'remote PATH'
    }
  }
  const wslDistro = context.wslDistro ?? parseWslPath(cwd)?.distro
  return { kind: 'local', cwd, ...(wslDistro ? { wslDistro } : {}) }
}

export async function rankAiVaultSessionsWithModel(
  args: AiVaultRankSessionsArgs,
  settings: GlobalSettings,
  repo?: AiVaultSessionSearchRepo | null,
  context: AiVaultSessionSearchTargetContext = {}
): Promise<AiVaultRankSessionsResult> {
  const fallbackIds = args.cards.map((card) => card.id)
  if (args.cards.length === 0) {
    return { ok: true, rankedIds: [], usedModel: false }
  }

  const resolved = resolveAiVaultSessionSearchGenerationParams(settings, repo)
  if (!resolved.ok) {
    return { ok: true, rankedIds: fallbackIds, usedModel: false }
  }

  const target = resolveAiVaultSessionSearchGenerationTarget(repo, context)
  if (!target) {
    return { ok: true, rankedIds: fallbackIds, usedModel: false }
  }

  const generated = await generateTextFromPrompt(
    buildAiVaultRerankPrompt(args.query, args.cards),
    resolved.params,
    target
  )
  if (!generated.success) {
    return {
      ok: false,
      error: generated.error,
      usedModel: false,
      rankedIds: fallbackIds
    }
  }

  return {
    ok: true,
    rankedIds: parseAiVaultRerankOutput(generated.message, fallbackIds),
    usedModel: true,
    agentLabel: generated.agentLabel
  }
}
