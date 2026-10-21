/** How a source catalog row looks once a local orcad owns it: no SSH connection or host. */
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'

export function toOrcadDestinationRepository(source: Repo): Repo {
  const destination = structuredClone(source)
  delete destination.connectionId
  delete destination.executionHostId
  return destination
}

export function toOrcadDestinationProjectGroup(source: ProjectGroup): ProjectGroup {
  const destination = structuredClone(source)
  destination.connectionId = null
  delete destination.executionHostId
  return destination
}

export function toOrcadDestinationFolderWorkspace(source: FolderWorkspace): FolderWorkspace {
  const destination = structuredClone(source)
  destination.connectionId = null
  delete destination.executionHostId
  destination.linkedTaskSourceContext ??= null
  return destination
}
