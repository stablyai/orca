import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: vi.fn(async (): Promise<'running' | 'stopped' | 'unverifiable'> => 'running'),
  realpath: vi.fn(async (path: string) =>
    path.replace('C:\\projects', '/physical').replaceAll('\\', '/')
  ),
  lstat: vi.fn(async () => ({
    isSymbolicLink: () => false,
    isDirectory: () => true,
    isFile: () => false
  })),
  git: vi.fn(async () => ({ stdout: '/mnt/c/projects/child\n' })),
  status: vi.fn(async () => ({ entries: [], conflictOperation: 'unknown' }))
}))
vi.mock('node:fs/promises', () => ({ realpath: mocks.realpath, lstat: mocks.lstat }))
vi.mock('../../wsl/discovery/wsl-background-distro-gate', () => ({
  readWslDistroRunningState: mocks.state
}))
vi.mock('../runner', () => ({
  gitExecFileAsync: mocks.git,
  gitOptionalLocksDisabledEnv: () => ({ GIT_OPTIONAL_LOCKS: '0' })
}))
vi.mock('./status-read', () => ({ getStatus: mocks.status }))
vi.mock('./check-ignored-paths', () => ({ checkIgnoredPaths: vi.fn() }))

import { getRepositoryStatuses } from './repository-status'

const platform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  vi.clearAllMocks()
})

it('gates both UNC and explicit distro reads before filesystem access, then maps a running drive-mount folder', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  const root = '\\\\wsl.localhost\\Ubuntu\\mnt\\c\\projects'
  const request = { repositoryPaths: ['child'], repositoryIntent: 'status' as const }
  for (const state of ['stopped', 'unverifiable'] as const) {
    mocks.state.mockResolvedValue(state)
    await expect(getRepositoryStatuses(root, request)).rejects.toThrow()
    await expect(
      getRepositoryStatuses('C:\\projects', request, { wslDistro: 'Ubuntu' })
    ).rejects.toThrow()
    expect(mocks.realpath).not.toHaveBeenCalled()
    expect(mocks.lstat).not.toHaveBeenCalled()
    expect(mocks.git).not.toHaveBeenCalled()
  }
  mocks.state.mockResolvedValue('running')
  const result = await getRepositoryStatuses(root, request, { wslDistro: 'Ubuntu' })
  expect(mocks.realpath.mock.calls[0]).toEqual(['C:\\projects'])
  expect(result.repositoryStatuses).toEqual([
    { path: 'child', kind: 'repository', status: { entries: [], conflictOperation: 'unknown' } }
  ])
  expect(mocks.status).toHaveBeenCalledWith(
    `${root}\\child`,
    expect.objectContaining({
      wslDistro: 'Ubuntu',
      includeIgnored: false,
      includeLineStats: false,
      skipEffectiveUpstream: true
    })
  )
})
