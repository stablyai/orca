import type { CommandTemplateBackslash } from '../../shared/commit-message-prompt'
import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import { planAgentBinary } from '../../shared/commit-message-plan'
import type { AgentModelProbeSpec } from '../../shared/agent-model-probe-spec'
import { formatAgentCliFailureMessage } from './source-control-agent-failure'
import type { DiscoverCommitMessageModelsResult } from './source-control-text-generation-types'

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
  code: number | null
): DiscoverCommitMessageModelsResult {
  if (code !== 0) {
    console.error('[commit-message] Model discovery failed:', {
      label: spec.label,
      exitCode: code,
      stdout,
      stderr
    })
    return {
      success: false,
      error: formatAgentCliFailureMessage(spec.label, stdout, stderr, code)
    }
  }
  let models = spec.modelDiscovery?.parse(stdout) ?? []
  if (models.length === 0 && stderr.trim()) {
    models = spec.modelDiscovery?.parse(stderr) ?? []
  }
  if (models.length === 0) {
    if (spec.models.length > 0) {
      console.warn('[commit-message] Model discovery returned no models; using static fallback:', {
        label: spec.label
      })
      return staticModelDiscoveryResult(spec)
    }
    return { success: false, error: `${spec.label} returned no available models.` }
  }
  const defaultModelId = models.some((model) => model.id === spec.defaultModelId)
    ? spec.defaultModelId
    : models[0].id
  return staticModelDiscoveryResult(spec, models, defaultModelId, 'probe')
}

export function planModelDiscovery(
  spec: AgentModelProbeSpec,
  agentCommandOverride?: string,
  backslash: CommandTemplateBackslash = 'escape'
): { ok: true; plan: CommitMessagePlan } | { ok: false; error: string } {
  const modelDiscovery = spec.modelDiscovery
  if (!modelDiscovery) {
    return { ok: false, error: `${spec.label} does not support dynamic model discovery.` }
  }
  const command = planAgentBinary(modelDiscovery.binary, agentCommandOverride, backslash)
  if (!command.ok) {
    return command
  }
  return {
    ok: true,
    plan: {
      binary: command.binary,
      args: [...command.prefixArgs, ...modelDiscovery.args],
      stdinPayload: modelDiscovery.stdinPayload ?? null,
      label: spec.label
    }
  }
}
