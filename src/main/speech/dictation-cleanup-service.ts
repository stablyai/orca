import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DICTATION_CLEANUP_TIMEOUT_MS,
  isDictationCleanupOn,
  type DictationCleanupResult
} from '../../shared/dictation-cleanup'
import type { DictationTerm } from '../../shared/dictation-dictionary'
import type { VoiceSettings } from '../../shared/speech-types'
import { getCommitMessageModel } from '../../shared/source-control/ai/generation/commit-message-agent-spec'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from '../text-generation/execution/commit-message-agent-environment'
import { resolveCommitMessageSettings as resolveTextGenerationParams } from '../text-generation/commit-message-text-generation'
import { generateDictationCleanup } from '../text-generation/requests/dictation-cleanup-generation-request'
import { cancelLocalGeneration } from '../text-generation/execution/source-control-generation-lanes'

export type DictationCleanupDeps = {
  getSettings: () => Parameters<typeof resolveTextGenerationParams>[0] & { voice?: VoiceSettings }
  getAgentEnvResolvers: () => CommitMessageAgentEnvironmentResolvers | undefined
}

const skipsByRequest = new Map<string, () => void>()

export function cancelDictationCleanup(requestId: string): void {
  skipsByRequest.get(requestId)?.()
}

// One folder for every run, so the agent reads no project and keeps one history bucket, not one per dictation.
const cleanupFolder = (): string => join(tmpdir(), 'orca-dictation-cleanup')

/** Runs the user's agent on dictated text, on this computer, in an empty folder of its own. */
export async function cleanUpDictatedText(
  input: { text: string; terms: readonly DictationTerm[]; requestId?: string },
  deps: DictationCleanupDeps
): Promise<DictationCleanupResult> {
  const settings = deps.getSettings()
  if (!input.text.trim() || !isDictationCleanupOn(settings)) {
    return { status: 'off' }
  }
  const startedAt = Date.now()
  const stop = Promise.withResolvers<'timed-out' | 'canceled'>()
  const timer = setTimeout(() => stop.resolve('timed-out'), DICTATION_CLEANUP_TIMEOUT_MS)
  if (input.requestId) {
    skipsByRequest.set(input.requestId, () => stop.resolve('canceled'))
  }
  let stopped = false
  const cwd = cleanupFolder()
  try {
    const resolved = resolveTextGenerationParams(settings, undefined, 'dictationCleanup')
    if (!resolved.ok) {
      return { status: 'failed', reason: resolved.error }
    }
    const { params } = resolved
    const prepared = await Promise.race([
      prepareLocalCommitMessageAgentEnv(params.agentId, deps.getAgentEnvResolvers()),
      stop.promise
    ])
    if (typeof prepared === 'string') {
      return { status: prepared }
    }
    if (!prepared.ok) {
      return { status: 'failed', reason: prepared.error }
    }
    await mkdir(cwd, { recursive: true })
    const generation = generateDictationCleanup({
      text: input.text,
      voice: settings.voice,
      terms: input.terms,
      params,
      target: { kind: 'local', cwd, ...(prepared.env ? { env: prepared.env } : {}) }
    })
    const outcome = await Promise.race([generation, stop.promise])
    if (typeof outcome === 'string') {
      stopped = true
      return { status: outcome }
    }
    if (!outcome.success) {
      return outcome.canceled ? { status: 'canceled' } : { status: 'failed', reason: outcome.error }
    }
    return {
      status: 'cleaned',
      text: outcome.text,
      agentLabel: outcome.agentLabel ?? params.agentId,
      model:
        (params.agentId !== 'custom' &&
          getCommitMessageModel(params.agentId, params.model)?.label) ||
        params.model,
      elapsedMs: Date.now() - startedAt
    }
  } catch (error) {
    return { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    if (input.requestId) {
      skipsByRequest.delete(input.requestId)
    }
    // Stops the agent still running after a timeout or a skip.
    if (stopped) {
      cancelLocalGeneration('dictation-cleanup', cwd)
    }
  }
}
