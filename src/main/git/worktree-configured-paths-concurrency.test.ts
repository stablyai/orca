import { beforeEach, describe, expect, it, vi } from 'vitest'

const { statMock, lstatMock, readFileMock, loadHooksMock, checkIgnoredPathsMock, concurrency } =
  vi.hoisted(() => ({
    statMock: vi.fn(),
    lstatMock: vi.fn(),
    readFileMock: vi.fn(),
    loadHooksMock: vi.fn(),
    checkIgnoredPathsMock: vi.fn(),
    concurrency: { active: 0, max: 0 }
  }))

vi.mock('node:fs/promises', () => ({
  stat: statMock,
  lstat: lstatMock,
  readFile: readFileMock
}))

vi.mock('../hooks', () => ({
  loadHooks: loadHooksMock
}))

vi.mock('./check-ignored-paths', () => ({
  checkIgnoredPaths: checkIgnoredPathsMock
}))

import { resolveWorktreeIncludePaths } from './worktree-include-file'
import { resolveWorktreeSharedDirectories } from './worktree-shared-directories'

const PATH_COUNT = 16
const configuredPaths = Array.from({ length: PATH_COUNT }, (_, index) => `path-${index}`)

async function delayedProbe<T>(value: T): Promise<T> {
  concurrency.active += 1
  concurrency.max = Math.max(concurrency.max, concurrency.active)
  await new Promise((resolve) => setTimeout(resolve, 5))
  concurrency.active -= 1
  return value
}

describe('configured worktree path probe concurrency', () => {
  beforeEach(() => {
    statMock.mockReset()
    lstatMock.mockReset()
    readFileMock.mockReset()
    loadHooksMock.mockReset()
    checkIgnoredPathsMock.mockReset()
    concurrency.active = 0
    concurrency.max = 0
    checkIgnoredPathsMock.mockResolvedValue(configuredPaths)
  })

  it('bounds shared-directory stats while retaining configured order', async () => {
    loadHooksMock.mockReturnValue({ worktree: { sharedDirectories: configuredPaths } })
    statMock.mockImplementation(async () => delayedProbe({ isDirectory: () => true }))

    const result = await resolveWorktreeSharedDirectories('/repo')

    expect(result).toEqual([...configuredPaths].sort())
    expect(checkIgnoredPathsMock).toHaveBeenCalledWith('/repo', configuredPaths, {})
    expect(concurrency.max).toBeGreaterThan(1)
    expect(concurrency.max).toBeLessThanOrEqual(8)
  })

  it('bounds include-path lstat probes while retaining candidate order', async () => {
    const includePath = '/repo/.worktreeinclude'
    loadHooksMock.mockReturnValue(null)
    lstatMock.mockImplementation(async (path: string) => {
      if (path === includePath) {
        return { isFile: () => true, size: 1 }
      }
      return delayedProbe({})
    })
    readFileMock.mockResolvedValue(configuredPaths.join('\n'))

    const result = await resolveWorktreeIncludePaths('/repo')

    expect(result).toEqual([...configuredPaths].sort())
    expect(checkIgnoredPathsMock).toHaveBeenCalledWith('/repo', configuredPaths, {})
    expect(concurrency.max).toBeGreaterThan(1)
    expect(concurrency.max).toBeLessThanOrEqual(8)
  })
})
