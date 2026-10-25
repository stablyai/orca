/** What the projection compares and what it must not hide: scope edges, user text, aliases. */
import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../shared/project-group-types'
import {
  WSL_MOVER_DISTRO,
  wslMoverProfile,
  wslMoverProfileScope,
  type WslMoverProfileName
} from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { findMissingWslMoveAliases } from './wsl-move-compatibility-aliases'
import { PERSISTED_STATE_DISPOSITIONS } from '../../../shared/wsl-move/wsl-move-dispositions'
import {
  projectWslMoveState,
  WSL_MOVE_PROJECTED_STATE_FIELDS,
  WSL_MOVE_PROJECTION_DEFERRED,
  type WslMoveProjectionInput
} from './wsl-move-state-projection'

const project = (
  name: WslMoverProfileName,
  side: 'source' | 'destination',
  edit?: (input: WslMoveProjectionInput) => void
): unknown => {
  const input = wslMoverProfile(name, side)
  edit?.(input)
  return projectWslMoveState(input, wslMoverProfileScope(name, side))
}

const UNC_APP = `repo-a::\\\\wsl.localhost\\${WSL_MOVER_DISTRO}\\home\\dev\\app`

describe('projectWslMoveState scope', () => {
  it('compares or defers every state field the move carries', () => {
    const moved = Object.entries(PERSISTED_STATE_DISPOSITIONS)
      .filter(([, row]) => row.disposition === 'move')
      .map(([field]) => field)
    const accounted = new Set<string>([
      ...WSL_MOVE_PROJECTED_STATE_FIELDS,
      ...Object.keys(WSL_MOVE_PROJECTION_DEFERRED)
    ])
    expect(moved.filter((field) => !accounted.has(field))).toEqual([])
  })

  it('compares user text byte for byte', () => {
    const rewritten = project('heavy-wsl', 'destination', (input) => {
      for (const files of Object.values(input.session.openFilesByWorktree ?? {})) {
        for (const file of files) {
          file.dirtyDraftContent = 'cd /home/dev/app'
        }
      }
    })
    const source = project('heavy-wsl', 'source', (input) => {
      for (const files of Object.values(input.session.openFilesByWorktree ?? {})) {
        for (const file of files) {
          file.dirtyDraftContent = `cd ${UNC_APP.slice('repo-a::'.length)}`
        }
      }
    })
    expect(rewritten).not.toEqual(source)
  })

  it('compares a task source on another host', () => {
    const withSource = (hostId: `ssh:${string}`) => (input: WslMoveProjectionInput) => {
      input.state.automations[0].sourceContext = {
        kind: 'task-source',
        provider: 'github',
        projectId: 'project-auto',
        hostId
      }
    }
    expect(project('folders-and-automations', 'destination', withSource('ssh:b'))).not.toEqual(
      project('folders-and-automations', 'source', withSource('ssh:a'))
    )
  })

  it('reports a lost ancestor project group', () => {
    const root: ProjectGroup = {
      id: 'group-root',
      name: 'Root',
      parentPath: null,
      parentGroupId: null,
      createdFrom: 'manual',
      tabOrder: 0,
      isCollapsed: false,
      color: null,
      createdAt: 1,
      updatedAt: 1
    }
    const nest = (keepRoot: boolean) => (input: WslMoveProjectionInput) => {
      input.state.projectGroups = [
        ...(keepRoot ? [root] : []),
        ...input.state.projectGroups.map((group) => ({ ...group, parentGroupId: root.id }))
      ]
    }
    expect(project('folders-and-automations', 'destination', nest(true))).toEqual(
      project('folders-and-automations', 'source', nest(true))
    )
    expect(project('folders-and-automations', 'destination', nest(false))).not.toEqual(
      project('folders-and-automations', 'source', nest(true))
    )
  })

  it('ignores an SSH repo that shares a moved id, and Windows siblings of a moved project', () => {
    const source = project('mixed-windows-wsl', 'source', (input) => {
      input.state.repos.push({
        ...input.state.repos[0],
        path: '/srv/remote',
        executionHostId: 'ssh:target'
      })
      input.state.projects[0].sourceRepoIds.push('repo-win')
    })
    expect(project('mixed-windows-wsl', 'destination')).toEqual(source)
  })

  it("ignores other hosts' sidebar order and devices with no moved selection", () => {
    const source = project('heavy-wsl', 'source', (input) => {
      input.ui?.manualRepoOrder?.push({ hostId: 'ssh:target', repoId: 'repo-a' })
      input.state.mobileClientTabSelectionsByDeviceId = {
        phone: {
          'repo-win::C:\\src\\win': {
            activeTabId: 'tab-w',
            activeGroupId: null,
            activeTabIdByGroupId: {}
          }
        }
      }
    })
    expect(project('heavy-wsl', 'destination')).toEqual(source)
  })

  it('compares terminal pane titles byte for byte', () => {
    const renamed = project('heavy-wsl', 'destination', (input) => {
      const layout = input.session.terminalLayoutsByTabId?.['tab-1']
      if (layout?.titlesByLeafId) {
        layout.titlesByLeafId['leaf-1'] = '/home/dev/app'
      }
    })
    const source = project('heavy-wsl', 'source', (input) => {
      const layout = input.session.terminalLayoutsByTabId?.['tab-1']
      if (layout?.titlesByLeafId) {
        layout.titlesByLeafId['leaf-1'] = `\\\\wsl.localhost\\${WSL_MOVER_DISTRO}\\home\\dev\\app`
      }
    })
    expect(renamed).not.toEqual(source)
  })

  it('compares metadata that exists only as an identity row', () => {
    const canonicalOnly = (input: WslMoveProjectionInput) => {
      const [worktreeId, meta] = Object.entries(input.state.worktreeMeta)[0]
      delete input.state.worktreeMeta[worktreeId]
      input.state.worktreeMetaByIdentity = { 'wt2:local:instance-app': meta }
      input.state.worktreeIdentityAliases = { [`local|${worktreeId}`]: ['wt2:local:instance-app'] }
    }
    expect(project('heavy-wsl', 'destination')).toEqual(
      project('heavy-wsl', 'source', canonicalOnly)
    )
    const lost = project('heavy-wsl', 'destination', (input) => {
      delete input.state.worktreeMeta[Object.keys(input.state.worktreeMeta)[0]]
    })
    expect(lost).not.toEqual(project('heavy-wsl', 'source', canonicalOnly))
  })
})

describe('findMissingWslMoveAliases', () => {
  const scope = wslMoverProfileScope('heavy-wsl', 'destination')
  const sourceIds = Object.keys(wslMoverProfile('heavy-wsl', 'source').state.worktreeMeta)

  it('accepts a destination that keeps every moved UNC id', () => {
    const destination = wslMoverProfile('heavy-wsl', 'destination').state.worktreeMeta
    expect(findMissingWslMoveAliases(sourceIds, destination, scope)).toEqual([])
  })

  it('names a moved id the destination dropped', () => {
    const destination = wslMoverProfile('heavy-wsl', 'destination').state.worktreeMeta
    delete destination['repo-a::/home/dev/app'].priorWorktreeIds
    expect(findMissingWslMoveAliases(sourceIds, destination, scope)).toEqual([UNC_APP])
  })
})
