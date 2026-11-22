import { existsSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn()
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: gitExecFileSyncMock
}))

vi.mock('../../command-runner/host-routing/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('../../source-control/resolve-git-dir', () => ({
  resolveGitDir: resolveGitDirMock
}))

vi.mock('../../source-control/git-read-cache-invalidation', () => ({
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})
import {
  createGitCallReader,
  createGitCommandMocker,
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'

import { removeWorktree } from './worktree-removal'
import * as nativeRemoval from './windows-worktree-removal'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

// Pin non-Windows argv; Windows removal also sets core.longpaths.
let platformSpy: MockInstance<() => NodeJS.Platform>

beforeEach(() => {
  resetWorktreeRemovalState()
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})

afterEach(() => {
  platformSpy.mockRestore()
})

describe('removeWorktree', () => {
  beforeEach(() => {
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      readFileMock,
      resolveGitDirMock
    })
  })

  it('removes the empty directory Git left after a successful remove', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-remove-residue-'))
    const worktreePath = join(scratch, 'feature')
    await mkdir(worktreePath, { recursive: true })
    try {
      mockGitCommands({})

      await removeWorktree('/repo', worktreePath, false, {
        knownRemovedWorktree: { branch: '', head: '', locked: false }
      })

      expect(existsSync(worktreePath)).toBe(false)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('keeps files found at the path after Git removed the checkout', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-remove-recreated-'))
    const worktreePath = join(scratch, 'feature')
    // Indistinguishable from a folder recreated at the path once Git has removed the checkout.
    await mkdir(join(worktreePath, 'notes'), { recursive: true })
    try {
      mockGitCommands({})

      await expect(
        removeWorktree('/repo', worktreePath, false, {
          knownRemovedWorktree: { branch: '', head: '', locked: false }
        })
      ).rejects.toThrow('A different checkout is now at')

      expect(existsSync(join(worktreePath, 'notes'))).toBe(true)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('leaves a WSL checkout that Git reported removed to the distro', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-remove-residue-wsl-'))
    const worktreePath = join(scratch, 'feature')
    await mkdir(worktreePath, { recursive: true })
    try {
      mockGitCommands({})

      await removeWorktree('/repo', worktreePath, false, {
        wslDistro: 'Ubuntu',
        knownRemovedWorktree: { branch: '', head: '', locked: false }
      })

      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
})

it('finishes native Git registration and branch cleanup when checkout stop follows physical success', async () => {
  platformSpy.mockReturnValue('win32')
  const directory = await mkdtemp(join(tmpdir(), 'orca-native-finalization-'))
  const checkout = join(directory, 'feature')
  await mkdir(checkout)
  const controller = new AbortController()
  const physical = vi.spyOn(nativeRemoval, 'removeWindowsCheckout').mockImplementation(async () => {
    await rm(checkout, { recursive: true })
    controller.abort(new Error('host stopping after checkout completion'))
  })
  let registered = true
  gitExecFileAsyncMock.mockImplementation(async (args: string[], options) => {
    if (options.signal?.aborted) {
      throw options.signal.reason
    }
    if (args.includes('list')) {
      return {
        stdout: registered ? `worktree ${checkout}\nHEAD abc\nbranch refs/heads/feature\n` : '',
        stderr: ''
      }
    }
    if (args.includes('remove')) {
      registered = false
    }
    return { stdout: '', stderr: '' }
  })
  try {
    await expect(
      removeWorktree(directory, checkout, false, {
        knownRemovedWorktree: { branch: 'feature', head: 'abc' },
        checkoutDeleteSignal: controller.signal
      })
    ).resolves.toEqual({})
    expect(existsSync(checkout)).toBe(false)
    expect(registered).toBe(false)
    expect(getGitCalls()).toContain('git branch -d -- feature')
  } finally {
    physical.mockRestore()
    await rm(directory, { recursive: true, force: true })
  }
})
