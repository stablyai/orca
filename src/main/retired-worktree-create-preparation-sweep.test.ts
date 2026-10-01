import { afterEach, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../shared/constants'
import type { Repo } from '../shared/repo-types'
import type { Store } from './persistence'
import { collectRetiredPreparationSweepTargets } from './retired-worktree-create-preparation-sweep-targets'
import { getWslHome } from './wsl'
import type * as Wsl from './wsl'

vi.mock('./wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof Wsl>()),
  getWslHome: vi.fn(() => '\\\\wsl.localhost\\Ubuntu\\home\\dev')
}))

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  if (platformDescriptor) {
    Object.defineProperty(process, 'platform', platformDescriptor)
  }
  vi.mocked(getWslHome).mockClear()
})

function repo(id: string, path: string, overrides: Partial<Repo> = {}): Repo {
  return { id, path, displayName: id, badgeColor: '#000000', addedAt: 0, ...overrides }
}

function storeWith(repos: Repo[], workspaceDir: string): Store {
  const store = {
    getRepos: () => repos,
    getSettings: () => ({ ...getDefaultSettings('/home/dev'), workspaceDir })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: collection reads only repos and settings, and a store without projects resolves every repo to host Git.
  return store as unknown as Store
}

it('collects local repos and their spare folders, skipping SSH repos and folder workspaces', () => {
  const targets = collectRetiredPreparationSweepTargets(
    storeWith(
      [
        repo('app', '/code/app'),
        repo('lib', '/code/lib'),
        repo('remote', '/srv/app', { connectionId: 'ssh-1' }),
        repo('notes', '/code/notes', { kind: 'folder' })
      ],
      '/home/dev/orca/workspaces'
    )
  )

  expect(targets).toEqual({
    workspaceRoots: ['/home/dev/orca/workspaces'],
    repos: [{ path: '/code/app' }, { path: '/code/lib' }]
  })
})

it('keeps a WSL repo for its registrations without resolving its root through wsl.exe', () => {
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' })
  const wslRepoPath = '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'

  const targets = collectRetiredPreparationSweepTargets(
    storeWith([repo('app', wslRepoPath)], 'C:\\Users\\dev\\orca\\workspaces')
  )

  expect(getWslHome).not.toHaveBeenCalled()
  expect(targets).toEqual({ workspaceRoots: [], repos: [{ path: wslRepoPath }] })
})
