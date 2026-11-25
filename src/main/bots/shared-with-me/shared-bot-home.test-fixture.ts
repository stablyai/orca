import { join } from 'node:path'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project/groups/project-group-types'
import { SharedBotHomes } from './shared-bot-home'

type Home = Pick<FolderWorkspace, 'id' | 'name' | 'folderPath' | 'projectGroupId'>

/** Real homes over a runtime store kept in memory: its groups and folder workspaces. */
export function memorySharedBotHomes(userDataPath: string) {
  const groups: ProjectGroup[] = []
  const folders: Home[] = []
  let next = 0
  const homes = new SharedBotHomes({
    userDataPath,
    botsRoot: () => join(userDataPath, 'bots'),
    store: {
      getProjectGroups: () => groups,
      createProjectGroup: (input) => {
        const group: ProjectGroup = {
          id: `group-${++next}`,
          name: input.name,
          parentPath: input.parentPath ?? null,
          parentGroupId: null,
          createdFrom: input.createdFrom ?? 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 0,
          updatedAt: 0
        }
        groups.push(group)
        return group
      },
      getFolderWorkspaces: () => folders
    },
    createFolderWorkspace: async (input) => {
      const home = { id: `home-${++next}`, ...input }
      folders.push(home)
      return home
    },
    deleteFolderWorkspace: async (id) => {
      folders.splice(
        folders.findIndex((home) => home.id === id),
        1
      )
    }
  })
  return { homes, groups, folders }
}
