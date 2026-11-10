import os from 'node:os'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../../shared/source-control/ai/generation/commit-message-host-key'
import { renderSourceControlActionCommandTemplate } from '../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { ResolvedSourceControlAiGenerationParams } from '../../shared/source-control/ai/source-control-ai-operation-resolution'
import {
  buildWorktreeIconBatchPrompt,
  extractWorktreeIconSvgs,
  formatWorktreeIconBatchList,
  type WorktreeIconGenerationResult
} from '../../shared/worktree/worktree-icon-generation'
import { runGenerationRequest } from './agent-generation-request'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from './commit-message-agent-environment'
import { resolveTextGenerationParams } from './commit-message-text-generation'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { loadCache, remember } from './worktree-icon-cache'

export type WorktreeIconGenerationHost = {
  getSettings: () => Parameters<typeof resolveTextGenerationParams>[0]
  getAgentEnvironment: () => CommitMessageAgentEnvironmentResolvers | undefined
  cacheFile: string
}

export const canceledIconResult = (): WorktreeIconGenerationResult => ({
  success: false,
  canceled: true,
  error: 'Generation canceled.'
})

type BatchAttempt = { params: ResolvedSourceControlAiGenerationParams; ownTemplate: boolean }

// The icon recipe runs first; the branch-name agent covers a broken icon recipe with the built-in prompt.
function resolveAttempts(host: WorktreeIconGenerationHost): BatchAttempt[] | string {
  const settings = host.getSettings()
  const icon = resolveTextGenerationParams(settings, LOCAL_COMMIT_MESSAGE_HOST_KEY, 'workspaceIcon')
  const fallback = resolveTextGenerationParams(
    settings,
    LOCAL_COMMIT_MESSAGE_HOST_KEY,
    'branchName'
  )
  const attempts: BatchAttempt[] = []
  if (icon.ok) {
    attempts.push({ params: icon.params, ownTemplate: true })
  }
  if (
    fallback.ok &&
    !(
      icon.ok &&
      fallback.params.agentId === icon.params.agentId &&
      fallback.params.model === icon.params.model
    )
  ) {
    attempts.push({ params: fallback.params, ownTemplate: false })
  }
  return attempts.length > 0 ? attempts : icon.ok ? 'No icon agent is available.' : icon.error
}

type AttemptOutcome = { svgs: (string | null)[]; error?: string } | { canceled: true }

async function runAttempt(
  host: WorktreeIconGenerationHost,
  attempt: BatchAttempt,
  names: string[],
  signal: AbortSignal
): Promise<AttemptOutcome> {
  const { params } = attempt
  const localEnv = await prepareLocalCommitMessageAgentEnv(
    params.agentId,
    host.getAgentEnvironment()
  )
  if (signal.aborted) {
    return { canceled: true }
  }
  if (!localEnv.ok) {
    return { svgs: names.map(() => null), error: localEnv.error }
  }
  const basePrompt = buildWorktreeIconBatchPrompt(names)
  const result = await runGenerationRequest({
    params,
    prompt:
      attempt.ownTemplate && params.commandInputTemplate !== undefined
        ? renderSourceControlActionCommandTemplate(params.commandInputTemplate, {
            basePrompt,
            workspaces: formatWorktreeIconBatchList(names)
          })
        : basePrompt,
    target: { kind: 'local', cwd: os.homedir(), ...(localEnv.env ? { env: localEnv.env } : {}) },
    spawnAgent: spawnSourceControlAgent,
    operation: 'worktree-icon',
    shouldExecute: () => !signal.aborted
  })
  if (signal.aborted || (!result.success && result.canceled)) {
    return { canceled: true }
  }
  if (!result.success) {
    return { svgs: names.map(() => null), error: result.error }
  }
  const svgs = extractWorktreeIconSvgs(result.rawOutput, names.length)
  const missing = svgs.filter((svg) => svg === null).length
  return missing === 0
    ? { svgs }
    : {
        svgs,
        error: `${result.agentLabel ?? 'The agent'} did not return a usable SVG icon for ${missing} of ${names.length} workspaces.`
      }
}

export async function generateWorktreeIconBatch(
  host: WorktreeIconGenerationHost,
  names: string[],
  signal: AbortSignal
): Promise<WorktreeIconGenerationResult[]> {
  const cache = loadCache(host.cacheFile)
  const attempts = resolveAttempts(host)
  if (typeof attempts === 'string') {
    return names.map(() => ({ success: false, error: attempts }))
  }
  const svgs: (string | null)[] = names.map(() => null)
  const errors: string[] = []
  for (const attempt of attempts) {
    const pending = names.flatMap((name, index) => (svgs[index] === null ? [{ name, index }] : []))
    if (pending.length === 0) {
      break
    }
    const outcome = await runAttempt(
      host,
      attempt,
      pending.map((entry) => entry.name),
      signal
    )
    if ('canceled' in outcome) {
      break
    }
    outcome.svgs.forEach((svg, position) => {
      svgs[pending[position].index] = svg
    })
    if (outcome.error) {
      errors.push(outcome.error)
    }
  }
  // Clearing replaces the cache; an older recipe must never repopulate its replacement.
  if (loadCache(host.cacheFile) !== cache) {
    return names.map(() => canceledIconResult())
  }
  const generated = new Map(
    names.flatMap((name, index) => {
      const svg = svgs[index]
      return svg ? [[name, svg] as const] : []
    })
  )
  // Finished icons are kept even when every card stopped waiting: they would be requested again.
  if (generated.size > 0) {
    remember(host.cacheFile, generated)
  }
  if (signal.aborted) {
    return names.map((name) => {
      const svg = generated.get(name)
      return svg ? { success: true, svg } : canceledIconResult()
    })
  }
  return names.map((name) => {
    const svg = generated.get(name)
    return svg
      ? { success: true, svg }
      : { success: false, error: errors.join('\n') || 'The agent did not return an SVG icon.' }
  })
}
