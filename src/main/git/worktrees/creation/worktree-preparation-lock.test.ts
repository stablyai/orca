import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { toHostFilesystemPath } from '../../../filesystem/host-tree-removal'
import type * as FilePromises from 'node:fs/promises'

const mocks = vi.hoisted(() => ({
  git: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn()
}))
vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: mocks.git
}))
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FilePromises>()),
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  unlink: mocks.unlink
}))

import {
  lockWorktreePreparation,
  resolveWorktreePreparationLockPath,
  unlockWorktreePreparation,
  unlockWorktreePreparationAtPath
} from './worktree-preparation-lock'

const lockReason = 'orca-create-preparation:v1:123:exact-session'
const commonDir = join(tmpdir(), 'repo', '.git')
const gitLockPath = join(commonDir, 'worktrees', 'prepared', 'locked')
const lockPath = toHostFilesystemPath(gitLockPath)

beforeEach(() => {
  mocks.git.mockReset().mockImplementation(async (args: string[]) => ({
    stdout:
      args.includes('--git-path') && args.includes('--git-common-dir')
        ? `${gitLockPath}\n${commonDir}\n`
        : `${args.includes('--git-path') ? gitLockPath : commonDir}\n`
  }))
  mocks.readFile.mockReset().mockResolvedValue(`${lockReason}\n`)
  mocks.writeFile.mockReset().mockResolvedValue(undefined)
  mocks.unlink.mockReset().mockResolvedValue(undefined)
})

describe('targeted preparation lock ownership', () => {
  it('preserves an existing lock if exclusive creation fails', async () => {
    const error = Object.assign(new Error('lock exists'), { code: 'EEXIST' })
    mocks.writeFile.mockRejectedValueOnce(error)
    await expect(lockWorktreePreparation('/prepared', lockReason, {})).rejects.toThrow(
      'lock owner changed'
    )
    expect(mocks.unlink).not.toHaveBeenCalled()
  })

  it.each([
    'user lock\n',
    'orca-create-preparation:v1:123:another-session\n',
    lockReason,
    `${lockReason}\n\n`
  ])('preserves a replacement owner: %s', async (reason) => {
    mocks.readFile.mockResolvedValueOnce(reason)
    await expect(unlockWorktreePreparation('/final', lockReason, {})).rejects.toThrow(
      'lock owner changed'
    )
    expect(mocks.unlink).not.toHaveBeenCalled()
  })

  it.each(['ENOENT', 'EACCES'])(
    'preserves the checkout when marker ownership cannot be read: %s',
    async (code) => {
      mocks.readFile.mockRejectedValueOnce(Object.assign(new Error('marker unavailable'), { code }))
      await expect(unlockWorktreePreparation('/final', lockReason, {})).rejects.toThrow(
        'lock owner changed'
      )
      expect(mocks.unlink).not.toHaveBeenCalled()
    }
  )

  it('honors cancellation after the path probe before writing a lock', async () => {
    const controller = new AbortController()
    const cancellation = new Error('lock canceled')
    mocks.git.mockImplementationOnce(async () => {
      controller.abort(cancellation)
      return { stdout: `${gitLockPath}\n${commonDir}\n` }
    })
    await expect(
      lockWorktreePreparation('/prepared', lockReason, { signal: controller.signal })
    ).rejects.toBe(cancellation)
    expect(mocks.git).toHaveBeenCalledOnce()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('honors cancellation during the ownership read before unlinking', async () => {
    const controller = new AbortController()
    const cancellation = new Error('unlock canceled')
    mocks.readFile.mockImplementationOnce(async () => {
      controller.abort(cancellation)
      return `${lockReason}\n`
    })
    await expect(
      unlockWorktreePreparationAtPath(lockPath, lockReason, controller.signal)
    ).rejects.toBe(cancellation)
    expect(mocks.unlink).not.toHaveBeenCalled()
  })
})

describe('combined preparation lock query', () => {
  it.each(['create', 'unlock'] as const)(
    'refuses a foreign administrative path before %s touches its marker',
    async (operation) => {
      const foreignLock = join(tmpdir(), 'other', '.git', 'worktrees', 'prepared', 'locked')
      mocks.git.mockResolvedValueOnce({ stdout: `${foreignLock}\n${commonDir}\n` })
      const run = operation === 'create' ? lockWorktreePreparation : unlockWorktreePreparation
      await expect(run('/prepared', lockReason, {})).rejects.toThrow('linked worktree lock path')
      expect(mocks.git).toHaveBeenCalledOnce()
      expect(mocks.readFile).not.toHaveBeenCalled()
      expect(mocks.writeFile).not.toHaveBeenCalled()
      expect(mocks.unlink).not.toHaveBeenCalled()
    }
  )

  it('forwards cancellation to both independent reads and never creates a marker', async () => {
    const controller = new AbortController()
    const cancellation = new Error('fallback canceled')
    const options = { signal: controller.signal, wslDistro: 'Ubuntu', timeout: 6000 }
    mocks.git.mockResolvedValueOnce({ stdout: 'ambiguous\n' }).mockImplementation(async (args) => {
      if (args.includes('--git-path')) {
        controller.abort(cancellation)
        return { stdout: `${gitLockPath}\n` }
      }
      return { stdout: `${commonDir}\n` }
    })
    await expect(lockWorktreePreparation('/prepared', lockReason, options)).rejects.toBe(
      cancellation
    )
    expect(mocks.git.mock.calls).toEqual([
      [['rev-parse', '--git-path', 'locked', '--git-common-dir'], { cwd: '/prepared', ...options }],
      [['rev-parse', '--git-path', 'locked'], { cwd: '/prepared', ...options }],
      [['rev-parse', '--git-common-dir'], { cwd: '/prepared', ...options }]
    ])
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })
})

describe('Git preparation lock path resolution', () => {
  it.each([
    { lock: '/repo/.git/locked\n', common: '/repo/.git\n' },
    { lock: '/other/.git/worktrees/prepared/locked\n', common: '/repo/.git\n' },
    { lock: '/repo/.git/worktrees/prepared/nested/locked\n', common: '/repo/.git\n' },
    { lock: '/repo/.git/worktrees/prepared/locked\n', common: '' }
  ])('rejects a path without one linked administration entry: $lock', ({ lock, common }) => {
    expect(() => resolveWorktreePreparationLockPath('/prepared', lock, common)).toThrow(
      'linked worktree lock path'
    )
  })
})
