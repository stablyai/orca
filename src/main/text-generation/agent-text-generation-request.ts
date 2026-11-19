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
} from './execution/commit-message-agent-environment'
import { spawnSourceControlAgent } from './execution/source-control-agent-launch'
import { cancelLocalGeneration } from './execution/source-control-generation-lanes'
import type { SpawnSourceControlAgent } from './source-control-text-generation-types'

/** How long a canceled agent may take to close before the request gives up waiting for it. */
const AGENT_CLOSE_GRACE_MS = 5_000

/**
 * Agents that turn their tools off for a text-only answer. Only the Claude spec passes the tool-free
 * flag; the others keep their tools, so a prompt could read local files. Widen this list only with a
 * verified flag for that agent.
 */
const TOOL_FREE_AGENT_IDS: readonly string[] = ['claude']

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
  if (!TOOL_FREE_AGENT_IDS.includes(args.agent)) {
    return {
      success: false,
      error: `Agent "${args.agent}" cannot answer without tools yet. Only ${TOOL_FREE_AGENT_IDS.join(', ')} can.`
    }
  }
  const agentId = args.agent
  const model = args.model ?? spec.defaultModelId
  const timeoutMs = args.timeoutMs ?? TEXT_GENERATE_DEFAULT_TIMEOUT_MS
  const startedAt = Date.now()
  const stop = Promise.withResolvers<'timed-out' | 'canceled'>()
  let stopReason: 'timed-out' | 'canceled' | undefined
  const requestStop = (reason: 'timed-out' | 'canceled'): void => {
    stopReason ??= reason
    stop.resolve(reason)
  }
  const timer = setTimeout(() => requestStop('timed-out'), timeoutMs)
  const onAbort = (): void => requestStop('canceled')
  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) {
    onAbort()
  }
  let cwd: string | undefined
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
    // A stop that arrived while the folder was being made must not start the agent at all.
    if (stopReason) {
      return stoppedResult(stopReason)
    }
    const generation = runGenerationRequest({
      params: { agentId, model, ...(args.effort ? { thinkingLevel: args.effort } : {}) },
      prompt: args.prompt,
      target: { kind: 'local', cwd, ...(prepared.env ? { env: prepared.env } : {}) },
      operation: 'agent-text',
      spawnAgent,
      shouldExecute: () => stopReason === undefined,
      timeoutMs
    })
    const outcome = await Promise.race([generation, stop.promise])
    if (typeof outcome === 'string') {
      // Stop the agent first, then wait for it to close: the folder must not go while a process still runs in it.
      cancelLocalGeneration('agent-text', cwd)
      await waitForClose(generation)
      return stoppedResult(outcome)
    }
    if (!outcome.success) {
      return {
        success: false,
        error: outcome.error,
        ...(outcome.canceled ? { canceled: true } : {}),
        ...(outcome.errorCode === 'timedOut' ? { timedOut: true } : {})
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
      await rm(cwd, { recursive: true, force: true }).catch((error: unknown) => {
        console.error('[text-generate] Could not remove the request folder:', error)
      })
    }
  }
}

/** Resolves when the generation settles, or after the grace period, whichever comes first. */
function waitForClose(generation: Promise<unknown>): Promise<void> {
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const grace = new Promise<void>((resolve) => {
    graceTimer = setTimeout(resolve, AGENT_CLOSE_GRACE_MS)
  })
  return Promise.race([generation.then(noop, noop), grace]).finally(() => clearTimeout(graceTimer))
}

function noop(): void {}

function stoppedResult(reason: 'timed-out' | 'canceled'): TextGenerateResult {
  return reason === 'timed-out'
    ? { success: false, error: 'Text generation timed out.', timedOut: true }
    : { success: false, error: 'Text generation canceled.', canceled: true }
}
