import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { resolveWorkerLocalPlacement } from './worker-local-placement'

// No project-runtime resolution: placement follows the workspace path alone.
const store = {}

function repo(fields: Partial<Repo>): Repo {
  return {
    id: 'repo-1',
    path: '/work/repo',
    displayName: 'repo',
    badgeColor: '#737373',
    addedAt: 0,
    ...fields
  }
}

describe('resolveWorkerLocalPlacement', () => {
  it('places a native workspace on this host', () => {
    expect(resolveWorkerLocalPlacement(store, { path: '/work/repo', connectionId: null })).toEqual({
      path: '/work/repo'
    })
  })

  it('marks a WSL share path with its distro', () => {
    expect(
      resolveWorkerLocalPlacement(store, {
        path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo',
        connectionId: null
      })
    ).toEqual({ path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo', wsl: { distro: 'Ubuntu' } })
  })

  it.each([
    ['an SSH workspace', { path: '/remote/repo', connectionId: 'ssh-1' }],
    [
      'a workspace on another execution host',
      { path: '/work/repo', connectionId: null, repo: repo({ executionHostId: 'runtime:host-2' }) }
    ],
    ['an unresolved workspace', null]
  ])('does not place %s on this host', (_case, workspace) => {
    expect(resolveWorkerLocalPlacement(store, workspace)).toBeNull()
  })
})
