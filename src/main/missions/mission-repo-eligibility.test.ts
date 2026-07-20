import { describe, expect, it } from 'vitest'
import type { Repo } from '../../shared/types'
import {
  MISSION_NATIVE_LOCAL_ONLY_ERROR,
  isNativeLocalMissionRepo,
  requireNativeLocalMissionRepos
} from './mission-repo-eligibility'

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'r1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#000',
    addedAt: 1,
    ...overrides
  }
}

function makeStore(repos: Repo[]) {
  return {
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getProjects: () => [],
    getSettings: () => ({})
  }
}

describe('Mission repo eligibility', () => {
  it('accepts native local Git repos', () => {
    const repo = makeRepo()
    expect(isNativeLocalMissionRepo(makeStore([repo]) as never, repo)).toBe(true)
  })

  it.each([
    makeRepo({ connectionId: 'ssh-1' }),
    makeRepo({ connectionId: 'ssh-1', executionHostId: 'local' }),
    makeRepo({ executionHostId: 'runtime:builder' }),
    makeRepo({ kind: 'folder' }),
    makeRepo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' })
  ])('rejects non-native or non-Git repo %#', (repo) => {
    expect(isNativeLocalMissionRepo(makeStore([repo]) as never, repo)).toBe(false)
  })

  it('rejects a local Windows project configured to execute in WSL', () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const repo = makeRepo({ path: 'C:\\repos\\app' })
      const store = {
        getRepo: () => repo,
        getProjects: () => [
          {
            id: 'p1',
            sourceRepoIds: ['r1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
          }
        ],
        getSettings: () => ({
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        })
      }
      expect(isNativeLocalMissionRepo(store as never, repo)).toBe(false)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, 'platform', originalPlatform)
      }
    }
  })

  it('rejects the whole request instead of silently dropping an invalid repo', () => {
    const local = makeRepo()
    const remote = makeRepo({ id: 'r2', connectionId: 'ssh-1' })
    const store = makeStore([local, remote])
    expect(() => requireNativeLocalMissionRepos(store as never, ['r1', 'r2'])).toThrow(
      MISSION_NATIVE_LOCAL_ONLY_ERROR
    )
    expect(() => requireNativeLocalMissionRepos(store as never, ['r1', 'missing'])).toThrow(
      MISSION_NATIVE_LOCAL_ONLY_ERROR
    )
  })
})
