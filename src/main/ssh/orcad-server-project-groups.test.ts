import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../shared/project-group-types'
import { projectGroupsHeldByServer, serverHeldProjectGroups } from './orcad-server-project-groups'

function group(id: string, parentGroupId: string | null = null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: '/root',
    connectionId: 'ssh-shared',
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const NOTHING_LINKED = { repositoryIds: new Set<string>(), folderWorkspaceIds: new Set<string>() }
const payload = (groups: ProjectGroup[]) => ({
  repositories: [],
  folderWorkspaces: [],
  projectGroups: groups
})
const serverGroup = (id: string, connectionId: string | null = null) => ({
  id,
  parentGroupId: null,
  connectionId
})

describe('which project groups the server already holds', () => {
  it('holds a same-id group on its own machine, though no row sits in it', () => {
    expect(
      projectGroupsHeldByServer([group('empty')], { projectGroups: [serverGroup('empty')] })
    ).toEqual(['empty'])
  })

  it('keeps a same-id group the server keeps for another host apart', () => {
    expect(
      projectGroupsHeldByServer([group('empty')], {
        projectGroups: [serverGroup('empty', 'server-ssh-host')]
      })
    ).toEqual([])
  })

  it('links a held group and its ancestors', () => {
    const held = serverHeldProjectGroups(
      payload([group('parent'), group('child', 'parent')]),
      NOTHING_LINKED,
      [],
      { projectGroups: [serverGroup('parent'), serverGroup('child')] }
    )
    expect(held.sort()).toEqual(['child', 'parent'])
  })

  // Codex repro: a foreign server row's group was taken as this machine's, hiding the conflict.
  it('takes no evidence from a server row or group on another host', () => {
    const held = serverHeldProjectGroups(
      payload([group('mine'), group('foreign'), group('via-row')]),
      NOTHING_LINKED,
      [
        { projectGroupId: 'foreign', connectionId: 'server-ssh-host' },
        { projectGroupId: 'via-row', executionHostId: 'ssh:server-ssh-host' }
      ],
      { projectGroups: [serverGroup('mine'), serverGroup('foreign', 'server-ssh-host')] }
    )
    expect(held).toEqual(['mine'])
  })

  it('keeps a same-id group stamped with another execution host apart', () => {
    expect(
      projectGroupsHeldByServer([group('empty')], {
        projectGroups: [{ ...serverGroup('empty'), executionHostId: 'ssh:server-ssh-host' }]
      })
    ).toEqual([])
  })

  // Codex repro: the ancestor walk took a foreign same-id parent as this machine's.
  it('does not link a parent the server keeps for another host', () => {
    const held = serverHeldProjectGroups(
      payload([group('parent'), group('child', 'parent')]),
      NOTHING_LINKED,
      [],
      { projectGroups: [serverGroup('parent', 'server-ssh-host'), serverGroup('child')] }
    )
    expect(held).toEqual(['child'])
  })

  // Opus repro: a new parent the server lacks was linked, so a later row in it was refused.
  it('does not link a parent the server lacks', () => {
    const held = serverHeldProjectGroups(
      payload([group('new-parent'), group('child', 'new-parent')]),
      NOTHING_LINKED,
      [{ projectGroupId: 'child' }],
      { projectGroups: [serverGroup('child')] }
    )
    expect(held).toEqual(['child'])
  })

  it('without the server’s group list, links the group a local server row sits in', () => {
    expect(
      serverHeldProjectGroups(
        payload([group('g')]),
        NOTHING_LINKED,
        [{ projectGroupId: 'g' }],
        undefined
      )
    ).toEqual(['g'])
  })
})
