import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { ProjectGroup } from '../../shared/project-group-types'
import {
  MANAGED_PROJECT_GROUP_ROOT_DIRNAME,
  resolveDefaultProjectGroupFolder
} from '../../shared/project-group-folder'

/**
 * Gives a new local group a folder under ~/Orca/groups so it is usable without setup.
 * Returns the group unchanged when it already has a folder, is remote, or the folder
 * cannot be created.
 */
export async function ensureDefaultProjectGroupFolder(
  group: ProjectGroup,
  updateGroup: (groupId: string, updates: { parentPath: string }) => ProjectGroup | null
): Promise<ProjectGroup> {
  // Why: a remote group's folder must already exist on its own host.
  if (group.parentPath || group.connectionId) {
    return group
  }
  const defaultPath = resolveDefaultProjectGroupFolder(
    group,
    join(homedir(), MANAGED_PROJECT_GROUP_ROOT_DIRNAME),
    sep
  )
  try {
    await mkdir(defaultPath, { recursive: true })
  } catch {
    // Why: an unwritable home must not block group creation; the user can pick a folder later.
    return group
  }
  return updateGroup(group.id, { parentPath: defaultPath }) ?? group
}
