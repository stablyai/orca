import { describe, expect, it } from 'vitest'
import {
  WSL_MOVER_DISTRO,
  WSL_MOVER_PROFILE_NAMES,
  wslMoverProfile,
  wslMoverProfileScope
} from '../__fixtures__/wsl-mover/wsl-mover-profiles'
import { WORKSPACE_SESSION_DISPOSITIONS } from '../../../shared/wsl-move/wsl-move-dispositions'
import { createWslMoveStringNormalizer, isRecord } from './wsl-move-canonical-form'
import { projectWslMoveState, type WslMoveProjectionInput } from './wsl-move-state-projection'

const project = (
  name: (typeof WSL_MOVER_PROFILE_NAMES)[number],
  side: 'source' | 'destination',
  edit?: (input: WslMoveProjectionInput) => void
): unknown => {
  const input = wslMoverProfile(name, side)
  edit?.(input)
  return projectWslMoveState(input, wslMoverProfileScope(name, side))
}

function sessionOf(projection: unknown): Record<string, unknown> {
  const session = isRecord(projection) ? projection.session : undefined
  if (!isRecord(session)) {
    throw new Error('projection has no session')
  }
  return session
}

describe('projectWslMoveState', () => {
  it.each(WSL_MOVER_PROFILE_NAMES)('%s: the source before equals the destination after', (name) => {
    expect(project(name, 'destination')).toEqual(project(name, 'source'))
  })

  it('compares every moved session field the fixture holds', () => {
    const session = sessionOf(project('heavy-wsl', 'source'))
    const movedFields = Object.entries(WORKSPACE_SESSION_DISPOSITIONS)
      .filter(([, row]) => row.disposition === 'move')
      .map(([field]) => field)
      // Focus is reprojected; runtime-authored browser pages/intents cannot live in bridge partitions.
      .filter(
        (field) =>
          ![
            'activeWorktreeId',
            'activeWorkspaceKey',
            'clientHostedBrowserCloseIntentsByEnvironment',
            'clientHostedBrowserPagesByWorktree'
          ].includes(field)
      )
    const empty = movedFields.filter((field) => {
      const value = session[field]
      return (
        value === undefined || (typeof value === 'object' && Object.keys(value ?? {}).length === 0)
      )
    })
    expect(empty).toEqual([])
  })

  it('reports any moved session field the destination lost', () => {
    const source = project('heavy-wsl', 'source')
    const unnoticed = Object.keys(sessionOf(source)).filter((field) => {
      const lost = project('heavy-wsl', 'destination', (input) => {
        Reflect.deleteProperty(input.session, field)
      })
      return JSON.stringify(lost) === JSON.stringify(source)
    })
    expect(unnoticed).toEqual([])
  })

  it('reports an unsaved draft the destination lost', () => {
    const lost = project('heavy-wsl', 'destination', (input) => {
      for (const files of Object.values(input.session.openFilesByWorktree ?? {})) {
        for (const file of files) {
          delete file.dirtyDraftContent
        }
      }
    })
    expect(lost).not.toEqual(project('heavy-wsl', 'source'))
  })

  it('reports an automation run the destination lost', () => {
    const lost = project('folders-and-automations', 'destination', (input) => {
      input.state.automationRuns = []
    })
    expect(lost).not.toEqual(project('folders-and-automations', 'source'))
  })

  it('ignores PTY bindings, host bindings and re-derived revisions', () => {
    const rebound = project('heavy-wsl', 'destination', (input) => {
      input.session.terminalPtyIncarnationsByPaneKey = {
        'tab-1:leaf-1': 'new'
      }
      input.session.remoteSessionIdsByTabId = {}
      for (const tabs of Object.values(input.session.tabsByWorktree ?? {})) {
        for (const tab of tabs) {
          tab.ptyId = null
        }
      }
      for (const repo of input.state.repos) {
        repo.executionHostId = 'local'
      }
    })
    expect(rebound).toEqual(project('heavy-wsl', 'source'))
  })

  it('leaves Windows-drive and other-distro rows out of the move', () => {
    expect(project('mixed-windows-wsl', 'source')).toMatchObject({
      repos: [expect.objectContaining({ id: 'repo-a' })]
    })
  })

  it('refuses two spellings of one worktree that disagree', () => {
    expect(() =>
      project('heavy-wsl', 'source', (input) => {
        input.state.worktreeMeta['repo-a::\\\\wsl$\\Ubuntu\\home\\dev\\app'] = {
          ...input.state.worktreeMeta['repo-a::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'],
          comment: 'a different row'
        }
      })
    ).toThrow(/same thing/)
  })

  it('reads a host-qualified key and the bare key the import writes as one row', () => {
    const qualified = project('heavy-wsl', 'source', (input) => {
      const visits = input.session.lastVisitedAtByWorktreeId ?? {}
      input.session.lastVisitedAtByWorktreeId = Object.fromEntries(
        Object.entries(visits).map(([key, at]) => [`local|${key}`, at])
      )
    })
    expect(project('heavy-wsl', 'destination')).toEqual(qualified)
  })
})

describe('createWslMoveStringNormalizer', () => {
  const normalize = createWslMoveStringNormalizer({
    distro: WSL_MOVER_DISTRO,
    hostAliases: ['local', 'runtime:wsl:Ubuntu']
  })

  it.each([
    ['\\\\wsl.localhost\\Ubuntu\\home\\dev\\app', '/home/dev/app'],
    ['//wsl$/ubuntu/home/dev/app', '/home/dev/app'],
    ['\\\\wsl.localhost\\Ubuntu', '/'],
    ['repo::\\\\wsl.localhost\\Ubuntu\\srv\\x::workspace:abc', 'repo::/srv/x::workspace:abc'],
    ['file://wsl.localhost/Ubuntu/home/a.html', 'file:///home/a.html'],
    ['runtime:wsl:Ubuntu|repo::/home/dev/app', 'repo::/home/dev/app'],
    ['local', '<H>']
  ])('%s → %s', (input, output) => {
    expect(normalize(input)).toBe(output)
  })

  it('leaves other distros, Windows paths and Linux paths alone', () => {
    for (const value of ['\\\\wsl.localhost\\Debian\\home\\x', 'C:\\src\\win', '/home/dev']) {
      expect(normalize(value)).toBe(value)
    }
  })

  it('normalizes the parts of an editor file id', () => {
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
    const id = `editor:${encodeURIComponent(`r::${unc}`)}:local:${encodeURIComponent(`${unc}\\a.md`)}`
    expect(normalize(id)).toBe(
      `editor:${encodeURIComponent('r::/home/dev/app')}:${encodeURIComponent('<H>')}:${encodeURIComponent('/home/dev/app/a.md')}`
    )
  })
})
