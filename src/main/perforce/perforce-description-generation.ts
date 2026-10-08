import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolvePerforceAiParams } from '../../shared/perforce/perforce-ai-params'
import { requireRelativePaths } from '../../shared/perforce/perforce-arguments'
import type { PerforceBackend } from '../../shared/perforce/perforce-backend'
import { buildPerforceDescriptionPrompt } from '../../shared/perforce/perforce-description-prompt'
import type { PerforceSettings } from '../../shared/perforce/perforce-settings'
import {
  getSshGitProvider,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE
} from '../providers/ssh-git-dispatch'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/commit-message-agent-environment'
import {
  generateCommitMessageFromContext,
  type GenerateCommitMessageResult
} from '../text-generation/commit-message-text-generation'

export type PerforceDescriptionChangelist = 'default' | 'new' | number

/** Where the description agent runs: on the workspace's SSH host, or on this machine (WSL included). */
export type PerforceDescriptionAgentHost =
  | { kind: 'ssh'; connectionId: string }
  | {
      kind: 'local'
      wslDistro?: string
      agentEnvironment: CommitMessageAgentEnvironmentResolvers | undefined
    }

async function buildContext(
  backend: PerforceBackend,
  cwd: string,
  changelist: PerforceDescriptionChangelist,
  rawFilePaths: unknown
): Promise<CommitMessageDraftContext> {
  const filePaths = requireRelativePaths(rawFilePaths)
  const patch = await backend.diffText(cwd, filePaths)
  const label =
    changelist === 'default'
      ? 'default changelist'
      : changelist === 'new'
        ? 'new changelist'
        : `changelist ${changelist}`
  // Why: the shared prompt is worded for git; the file summary tells the agent this is a Perforce changelist.
  return {
    branch: null,
    stagedSummary: `Perforce ${label} (opened files):\n${filePaths.join('\n')}`,
    stagedPatch: patch
  }
}

/**
 * Drafts a changelist description with Settings > Perforce's agent and instructions, from the diff of
 * the given opened files. Desktop IPC and the runtime both call this; p4 runs in the caller's
 * settings scope.
 */
export async function generatePerforceDescription(input: {
  settings: Pick<GlobalSettings, 'defaultTuiAgent' | 'agentCmdOverrides'> &
    Partial<Pick<GlobalSettings, 'disabledTuiAgents'>>
  perforce: PerforceSettings
  backend: PerforceBackend
  cwd: string
  changelist: PerforceDescriptionChangelist
  filePaths: unknown
  agentHost: PerforceDescriptionAgentHost
}): Promise<GenerateCommitMessageResult> {
  const { perforce, cwd, agentHost } = input
  if (!perforce.aiDescriptionEnabled) {
    return { success: false, error: 'AI descriptions are turned off in Settings > Perforce.' }
  }
  const resolved = resolvePerforceAiParams({ settings: input.settings, perforce })
  if (!resolved.ok) {
    return { success: false, error: resolved.error }
  }
  // Why before reading the diff: a dropped SSH host should say so, not report an unreadable diff.
  if (agentHost.kind === 'ssh' && !getSshGitProvider(agentHost.connectionId)) {
    return { success: false, error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE }
  }
  const context = await buildContext(input.backend, cwd, input.changelist, input.filePaths).catch(
    () => null
  )
  if (!context) {
    return { success: false, error: 'Failed to read the changelist diff.' }
  }
  const prompt = buildPerforceDescriptionPrompt(context, perforce.aiInstructions)
  switch (agentHost.kind) {
    case 'ssh': {
      const provider = getSshGitProvider(agentHost.connectionId)
      if (!provider) {
        return { success: false, error: SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE }
      }
      return generateCommitMessageFromContext(
        context,
        resolved.params,
        {
          kind: 'remote',
          cwd,
          execute: (plan, planCwd, timeoutMs, operation) =>
            provider.executeCommitMessagePlan(plan, planCwd, timeoutMs, operation),
          missingBinaryLocation: 'remote PATH'
        },
        prompt
      )
    }
    case 'local': {
      const { wslDistro } = agentHost
      const localEnv = await prepareLocalCommitMessageAgentEnv(
        resolved.params.agentId,
        agentHost.agentEnvironment,
        wslDistro ? { runtime: 'wsl', wslDistro } : { runtime: 'host' }
      )
      if (!localEnv.ok) {
        return { success: false, error: localEnv.error }
      }
      return generateCommitMessageFromContext(
        context,
        resolved.params,
        { kind: 'local', cwd, ...(wslDistro ? { wslDistro } : {}), env: localEnv.env },
        prompt
      )
    }
  }
}
