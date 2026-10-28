import type { Project, ProjectHostSetupResult } from '../../shared/project-types'
import type { RuntimeStore } from './runtime-store-contract'
import { isTuiAgent } from '../../shared/tui-agent-config'

export function assertProjectSetupDefault(defaultTuiAgent: Project['defaultTuiAgent']): void {
  if (
    defaultTuiAgent !== undefined &&
    defaultTuiAgent !== null &&
    defaultTuiAgent !== 'blank' &&
    !isTuiAgent(defaultTuiAgent)
  ) {
    throw new Error('Unknown project default agent')
  }
}

export function saveProjectSetupDefault(
  store: RuntimeStore | null,
  result: ProjectHostSetupResult,
  defaultTuiAgent: Project['defaultTuiAgent']
): ProjectHostSetupResult {
  if (defaultTuiAgent === undefined) {
    return result
  }
  const project = store?.updateProject?.(result.project.id, { defaultTuiAgent })
  if (!project) {
    throw new Error(`Project not found: ${result.project.id}`)
  }
  return { ...result, project }
}
