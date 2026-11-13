import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isTuiAgent } from '../../shared/agent-launch/catalog/tui-agent-config'
import {
  COMMIT_MESSAGE_AGENT_SPECS,
  getCommitMessageAgentSpec
} from '../../shared/source-control/ai/generation/commit-message-agent-spec'
import {
  TEXT_GENERATE_DEFAULT_TIMEOUT_MS,
  type TextGenerateRequest,
  type TextGenerateResult
} from '../../shared/rpc-contract/text-params'
import { runGenerationRequest } from './agent-generation-request'
import {
  prepareLocalCommitMessageAgentEnv,
  type CommitMessageAgentEnvironmentResolvers
} from './commit-message-agent-environment'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { cancelLocalGeneration } from './source-control-generation-lanes'
import type { SpawnSourceControlAgent } from './source-control-text-generation-types'

export type AgentTextGenerationHost = {
  getAgentEnvironment: () => CommitMessageAgentEnvironmentResolvers | undefined
}

export function textGenerationAgentIds(): string[] {
  return Object.keys(COMMIT_MESSAGE_AGENT_SPECS)
}

/** Runs one agent once, without tools, on a prompt, in an empty folder of its own. */
export async function generateAgentText(
  host: AgentTextGenerationHost,
  args: TextGenerateRequest,
  signal?: AbortSignal,
  spawnAgent: SpawnSourceControlAgent = spawnSourceControlAgent
): Promise<TextGenerateResult> {
  const spec = isTuiAgent(args.agent) ? getCommitMessageAgentSpec(args.agent) : undefined
  if (!isTuiAgent(args.agent) || !spec) {
    return {
      success: false,
      error: `Agent "${args.agent}" cannot generate text. Use one of: ${textGenerationAgentIds().join(', ')}.`
    }
  }
  const agentId = args.agent
  const model = args.model ?? spec.defaultModelId
  const startedAt = Date.now()
  const stop = Promise.withResolvers<'timed-out' | 'canceled'>()
  const timer = setTimeout(
    () => stop.resolve('timed-out'),
    args.timeoutMs ?? TEXT_GENERATE_DEFAULT_TIMEOUT_MS
  )
  const onAbort = (): void => stop.resolve('canceled')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) {
    onAbort()
  }
  let cwd: string | undefined
  let stopped = false
  try {
    const prepared = await Promise.race([
      prepareLocalCommitMessageAgentEnv(agentId, host.getAgentEnvironment()),
      stop.promise
    ])
    if (typeof prepared === 'string') {
      return stoppedResult(prepared)
    }
    if (!prepared.ok) {
      return { success: false, error: prepared.error }
    }
    // A fresh folder per request: the agent reads no project, and concurrent requests never share a cancel lane.
    cwd = await mkdtemp(join(tmpdir(), 'orca-text-generate-'))
    const generation = runGenerationRequest({
      params: { agentId, model, ...(args.effort ? { thinkingLevel: args.effort } : {}) },
      prompt: args.prompt,
      target: { kind: 'local', cwd, ...(prepared.env ? { env: prepared.env } : {}) },
      operation: 'agent-text',
      spawnAgent
    })
    const outcome = await Promise.race([generation, stop.promise])
    if (typeof outcome === 'string') {
      stopped = true
      return stoppedResult(outcome)
    }
    if (!outcome.success) {
      return {
        success: false,
        error: outcome.error,
        ...(outcome.canceled ? { canceled: true } : {})
      }
    }
    return {
      success: true,
      text: outcome.rawOutput,
      agent: agentId,
      model,
      elapsedMs: Date.now() - startedAt
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (cwd) {
      if (stopped) {
        cancelLocalGeneration('agent-text', cwd)
      }
      await rm(cwd, { recursive: true, force: true }).catch(() => {})
    }
  }
}

function stoppedResult(reason: 'timed-out' | 'canceled'): TextGenerateResult {
  return reason === 'timed-out'
    ? { success: false, error: 'Text generation timed out.', timedOut: true }
    : { success: false, error: 'Text generation canceled.', canceled: true }
}
