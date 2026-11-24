import type { AgentSessionModelCatalogResult } from '../../../../shared/agent-session/agent-session-wire'
import type { PipelineV2EffectiveExecutor } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'

export function readPipelineV2TerminalOptions(
  frame: { source?: string; tail: string[] },
  catalog: AgentSessionModelCatalogResult
): { model: string; effort?: string } {
  if (frame.source !== 'screen' || catalog.origin === 'unknown') {
    throw new Error('pipeline_session_options_unverifiable')
  }
  const matches = new Map<string, { model: string; effort?: string }>()
  for (const line of frame.tail.slice(-8)) {
    if (!line.includes(' · ')) {
      continue
    }
    const head = line.trim().split(' · ')[0].toLowerCase()
    for (const row of catalog.models) {
      for (const name of new Set([row.id, row.label])) {
        const prefix = name.toLowerCase()
        if (head !== prefix && !head.startsWith(`${prefix} `)) {
          continue
        }
        const suffix = head.slice(prefix.length).trim()
        const effort = suffix
          ? row.efforts.find(
              (value) =>
                value.value.toLowerCase() === suffix || value.label.toLowerCase() === suffix
            )?.value
          : undefined
        if (suffix && !effort) {
          continue
        }
        const result = { model: row.resolvedModel ?? row.id, ...(effort ? { effort } : {}) }
        matches.set(JSON.stringify(result), result)
      }
    }
  }
  if (matches.size !== 1) {
    throw new Error('pipeline_session_options_unverifiable')
  }
  return matches.values().next().value!
}
export function assertPipelineV2SessionCompatible(
  expected: PipelineV2EffectiveExecutor,
  actual: {
    agent?: string
    surface?: string
    permissionMode?: string
    model?: string
    effort?: string
  }
): void {
  const permission = expected.permissionMode === 'default' ? 'own' : expected.permissionMode
  if (
    actual.agent !== expected.agent ||
    actual.surface !== expected.surface ||
    actual.model !== expected.model ||
    actual.effort !== expected.effort ||
    actual.permissionMode !== permission
  ) {
    throw new Error('pipeline_session_executor_changed')
  }
}
