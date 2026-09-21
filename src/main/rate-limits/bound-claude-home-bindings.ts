import { resolveClaudeHomeBindingForGroup } from '../../shared/claude-home-binding'
import {
  LOCAL_EXECUTION_HOST_ID,
  getProjectGroupExecutionHostId
} from '../../shared/execution-host'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { BoundClaudeHomeBinding } from './service/service-types'

/**
 * One row per owning group — a child that inherits its ancestor's directory resolves to that
 * ancestor, not to itself.
 *
 * Local groups only: a config dir is a filesystem path on exactly one host
 * (`docs/reference/ssh-execution-boundary.md`) and this reader runs on the client, so an `ssh:` or
 * `runtime:` group's path would either miss entirely or hit a same-named local directory holding
 * another identity's token.
 */
export function resolveLocalBoundClaudeHomes(
  groups: readonly ProjectGroup[]
): BoundClaudeHomeBinding[] {
  const byGroupId = new Map<string, BoundClaudeHomeBinding>()
  for (const group of groups) {
    if (getProjectGroupExecutionHostId(group) !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const binding = resolveClaudeHomeBindingForGroup(groups, group.id, LOCAL_EXECUTION_HOST_ID)
    if (binding) {
      byGroupId.set(binding.groupId, binding)
    }
  }
  return [...byGroupId.values()]
}
