import { buildClaudeModelListArgs } from '../../../shared/agent-session/options/model-catalog/claude-model-list-probe'
import type { CommitMessageModel } from '../../../shared/source-control/ai/generation/commit-message-agent-spec'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../../codex-cli/codex-read-only-app-server-args'
import type { CommandTemplateBackslash } from '../../../shared/source-control/ai/generation/commit-message-prompt'
import type { CommitMessagePlan } from '../../../shared/source-control/ai/generation/commit-message-plan'
import { planAgentBinary } from '../../../shared/agent-launch/startup/agent-command-plan'
import type { AgentModelProbeSpec } from '../../../shared/agent-session/options/model-catalog/agent-model-probe-spec'
import type { DiscoverCommitMessageModelsResult } from '../source-control-text-generation-types'

const ERRNO_CODE = /^E[A-Z0-9]{2,24}$/
const SIGNAL_NAME = /^SIG[A-Z0-9]+$/

/** Name plus a numeric JSON-RPC code or POSIX errno. Never `message` or `stack`. */
export function safeProbeErrorLog(error: unknown): { name: string; code?: number | string } {
  const name = error instanceof Error && error.name ? error.name : 'Error'
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return { name }
  }
  const code = error.code
  if (typeof code === 'number' && Number.isInteger(code)) {
    return { name, code }
  }
  if (typeof code === 'string' && ERRNO_CODE.test(code)) {
    return { name, code }
  }
  return { name }
}

/** Exit summary with no stdout, stderr, or command text. */
export function modelDiscoveryExitError(
  label: string,
  exitCode: number | null,
  signal?: string | null
): string {
  if (typeof signal === 'string' && SIGNAL_NAME.test(signal)) {
    return `${label} model discovery command exited with signal ${signal}.`
  }
  if (typeof exitCode === 'number' && Number.isInteger(exitCode)) {
    return `${label} model discovery command exited with code ${exitCode}.`
  }
  return `${label} model discovery command exited.`
}

export function logModelDiscoveryExit(
  label: string,
  exitCode: number | null,
  signal?: string | null
): string {
  const error = modelDiscoveryExitError(label, exitCode, signal)
  const safeSignal = typeof signal === 'string' && SIGNAL_NAME.test(signal) ? signal : undefined
  console.error('[commit-message] Model discovery failed:', {
    label,
    exitCode,
    ...(safeSignal ? { signal: safeSignal } : {})
  })
  return error
}

export function staticModelDiscoveryResult(
  spec: AgentModelProbeSpec,
  models = spec.models,
  defaultModelId = spec.defaultModelId,
  catalogOrigin: 'probe' | 'spec' = 'spec'
): Extract<DiscoverCommitMessageModelsResult, { success: true }> {
  return {
    success: true,
    capability: {
      id: spec.id,
      label: spec.label,
      modelSource: spec.modelSource,
      defaultModelId,
      models
    },
    models,
    defaultModelId,
    catalogOrigin
  }
}

export function finalizeModelDiscoveryOutput(
  spec: AgentModelProbeSpec,
  stdout: string,
  stderr: string,
  code: number | null,
  signal?: string | null
): DiscoverCommitMessageModelsResult {
  if (code !== 0) {
    return { success: false, error: logModelDiscoveryExit(spec.label, code, signal) }
  }
  const parse =
    spec.modelDiscovery && 'parse' in spec.modelDiscovery ? spec.modelDiscovery.parse : null
  let models = parse?.(stdout) ?? []
  if (models.length === 0 && stderr.trim()) {
    models = parse?.(stderr) ?? []
  }
  return discoveredModelsResult(spec, models)
}

/** Wraps a probe's models, falling back to the spec's list when it found none. */
export function discoveredModelsResult(
  spec: AgentModelProbeSpec,
  discovered: CommitMessageModel[]
): DiscoverCommitMessageModelsResult {
  let models = discovered
  if (models.length === 0) {
    if (spec.models.length > 0) {
      console.warn('[commit-message] Model discovery returned no models; using static fallback:', {
        label: spec.label
      })
      return staticModelDiscoveryResult(spec)
    }
    return { success: false, error: `${spec.label} returned no available models.` }
  }
  if (spec.id === 'opencode' || spec.id === 'opencode2') {
    const configuredDefault = spec.models.find((model) => model.id === 'default')
    if (configuredDefault && !models.some((model) => model.id === 'default')) {
      models = [configuredDefault, ...models]
    }
  }
  // Static default sentinels preserve the CLI's configured provider despite concrete discovered models.
  const defaultModelId =
    spec.defaultModelId === 'default' || models.some((model) => model.id === spec.defaultModelId)
      ? spec.defaultModelId
      : models[0].id
  return staticModelDiscoveryResult(spec, models, defaultModelId, 'probe')
}

export function planModelDiscovery(
  spec: AgentModelProbeSpec,
  agentCommandOverride?: string,
  backslash: CommandTemplateBackslash = 'escape',
  strictMcp = true
): { ok: true; plan: CommitMessagePlan } | { ok: false; error: string } {
  const modelDiscovery = spec.modelDiscovery
  if (!modelDiscovery) {
    return { ok: false, error: `${spec.label} does not support dynamic model discovery.` }
  }
  const command = planAgentBinary(modelDiscovery.binary, agentCommandOverride, backslash)
  if (!command.ok) {
    return command
  }
  const args =
    'listing' in modelDiscovery
      ? CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS
      : spec.id === 'claude'
        ? buildClaudeModelListArgs(strictMcp, command.prefixArgs)
        : modelDiscovery.args
  return {
    ok: true,
    plan: {
      binary: command.binary,
      args: [...command.prefixArgs, ...args],
      stdinPayload: 'stdinPayload' in modelDiscovery ? (modelDiscovery.stdinPayload ?? null) : null,
      label: spec.label,
      ...(command.env ? { env: command.env } : {})
    }
  }
}
