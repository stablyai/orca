import type { TaskViewPresetId } from '../../../src/shared/types'
import { getExplicitTaskQueryScope, parseTaskQuery } from '../../../src/shared/task-query'

export type MobileGitHubTaskKind = 'issues' | 'prs'

/** Resolve the mobile GitHub tab from explicit, unquoted scope tokens or its saved preset. */
export function resolveMobileGitHubTaskKind(
  query: string,
  fallbackPreset: TaskViewPresetId
): MobileGitHubTaskKind {
  const explicitScope = getExplicitTaskQueryScope(query)
  if (explicitScope === 'pr') {
    return 'prs'
  }
  if (explicitScope === 'issue') {
    return 'issues'
  }
  const parsed = parseTaskQuery(query)
  if (parsed.scope === 'pr') {
    return 'prs'
  }
  if (parsed.scope === 'issue') {
    return 'issues'
  }
  return fallbackPreset === 'prs' || fallbackPreset === 'my-prs' || fallbackPreset === 'review'
    ? 'prs'
    : 'issues'
}
