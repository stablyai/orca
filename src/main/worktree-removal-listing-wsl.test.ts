import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readWorktreeRemovalRecords, writeWorktreeRemovalRecords } from './worktree-removal-records'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { listWorktreesStrict } from './git/worktree'
import { retryFailedRemovalUnlessRegistered } from './worktree-removal-leftover'
import {
  loadWorktreeRemovalRecords,
  resumeInterruptedWorktreeRemovals,
  _resetPendingWorktreeRemovalsForTests,
  _settlePendingWorktreeRemovalsForTests,
  startBackgroundWorktreeRemoval,
  retryFailedWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from './worktree-background-removal'
import { failedWorktreeRemovals } from './worktree-removal-table'
import { withUnregisteredRemovalCheckouts } from './worktree-removal-listing'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('./git/worktree', () => ({ listWorktreesStrict: vi.fn(async () => []) }))

const originalPlatform = process.platform
const checkout = '/home/dev/feature'
const record = {
  worktreeId: 'repo-1::/home/dev/feature',
  repoId: 'repo-1',
  repoPath: '/home/dev/repo',
  worktreePath: checkout,
  branch: 'feature',
  head: 'abc',
  deleteBranch: true,
  force: false,
  requestedAt: 1,
  failure: { message: 'partial removal', failedAt: 2 }
}
const kinds = new Map<string, string>()
const files = new Map<string, string>()

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  failedWorktreeRemovals.set(record.worktreeId, record)
  runProcess.mockReset()
  vi.mocked(listWorktreesStrict).mockReset().mockResolvedValue([])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  kinds.clear()
  files.clear()
  runProcess.mockImplementation(async ({ args }: { args: string[] }) => {
    const command = args.at(-1) ?? ''
    const stat = /^LC_ALL=C stat -c %F -- '([^']+)'$/.exec(command)
    const read = /^cat -- '([^']+)'$/.exec(command)
    const value = stat ? kinds.get(stat[1]) : read ? files.get(read[1]) : undefined
    if (!stat && !read) {
      throw new Error(`Unexpected guest command: ${command}`)
    }
    return value === undefined
      ? {
          code: 1,
          stdout: '',
          stderr: 'stat: cannot stat: No such file or directory\n',
          timedOut: false
        }
      : { code: 0, stdout: `${value}\n`, stderr: '', timedOut: false }
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  _resetPendingWorktreeRemovalsForTests()
  vi.restoreAllMocks()
})

it('does not list an existing foreign WSL checkout as a missing removal leftover', async () => {
  kinds.set(checkout, 'directory')
  kinds.set(`${checkout}/.git`, 'directory')
  expect(await withUnregisteredRemovalCheckouts('repo-1', [], { wslDistro: 'Ubuntu' })).toEqual([])
  expect(failedWorktreeRemovals.has(record.worktreeId)).toBe(false)
})

it('keeps a proven WSL orphan whose Git link uses guest paths', async () => {
  kinds.set(checkout, 'directory')
  kinds.set(`${checkout}/.git`, 'regular file')
  kinds.set('/home/dev/repo/.git', 'directory')
  files.set(`${checkout}/.git`, 'gitdir: /home/dev/repo/.git/worktrees/feature')
  const rows = await withUnregisteredRemovalCheckouts('repo-1', [], { wslDistro: 'Ubuntu' })
  expect(rows).toMatchObject([{ path: checkout, removalError: 'partial removal' }])
  expect(failedWorktreeRemovals.has(record.worktreeId)).toBe(true)
  expect(runProcess).toHaveBeenCalled()
})

it('keeps pending cleanup when the WSL filesystem confirms the checkout is gone', async () => {
  const rows = await withUnregisteredRemovalCheckouts('repo-1', [], { wslDistro: 'Ubuntu' })
  expect(rows).toMatchObject([{ path: checkout, removalError: 'partial removal' }])
  expect(failedWorktreeRemovals.has(record.worktreeId)).toBe(true)
  expect(runProcess).toHaveBeenCalled()
})

it.each(['WSL distro unavailable', 'Permission denied'])(
  'retains the failed row when guest stat fails: %s',
  async (message) => {
    kinds.set(checkout, 'directory')
    const execute = runProcess.getMockImplementation()
    runProcess.mockImplementation(async (args) => {
      if (args.args.at(-1)?.includes('/feature/.git')) {
        throw new Error(message)
      }
      return execute?.(args)
    })
    const rows = await withUnregisteredRemovalCheckouts('repo-1', [], { wslDistro: 'Ubuntu' })
    expect(rows).toMatchObject([{ path: checkout, removalError: 'partial removal' }])
    expect(failedWorktreeRemovals.get(record.worktreeId)).toBe(record)
  }
)

it('refuses retry cleanup while a foreign checkout remains only inside WSL', async () => {
  kinds.set(checkout, 'directory')
  kinds.set(`${checkout}/.git`, 'directory')
  let retried = false
  await expect(
    retryFailedRemovalUnlessRegistered(
      record.worktreeId,
      checkout,
      [],
      () => {
        retried = true
        return Promise.resolve({})
      },
      { wslDistro: 'Ubuntu' }
    )
  ).rejects.toThrow('folder was left on disk')
  expect(retried).toBe(false)
  expect(failedWorktreeRemovals.get(record.worktreeId)).toBe(record)
})

it('keeps the initial background failure when Git drops a WSL checkout registration', async () => {
  failedWorktreeRemovals.clear()
  kinds.set(checkout, 'directory')
  const result = startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: record.worktreeId,
      repoId: record.repoId,
      repoPath: record.repoPath,
      worktree: { path: checkout, head: 'abc', branch: 'refs/heads/feature' },
      deleteBranch: true,
      force: false
    },
    getLocalOptions: () => ({ wslDistro: 'Ubuntu' }),
    run: async () => {
      throw new Error('guest delete denied')
    },
    publish: () => {}
  })
  await expect(result).rejects.toThrow('guest delete denied')
  await _settlePendingWorktreeRemovalsForTests()
  expect(failedWorktreeRemovals.get(record.worktreeId)?.failure?.message).toBe(
    'guest delete denied'
  )
})

it('retains a background failure when WSL becomes unavailable during settlement', async () => {
  failedWorktreeRemovals.clear()
  runProcess.mockRejectedValue(new Error('WSL distro unavailable'))
  const result = startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: record.worktreeId,
      repoId: record.repoId,
      repoPath: record.repoPath,
      worktree: { path: checkout, head: 'abc', branch: 'refs/heads/feature' },
      deleteBranch: true,
      force: false
    },
    getLocalOptions: () => ({ wslDistro: 'Ubuntu' }),
    run: async () => {
      throw new Error('guest delete interrupted')
    },
    publish: () => {}
  })
  await expect(result).rejects.toThrow('guest delete interrupted')
  await _settlePendingWorktreeRemovalsForTests()
  expect(failedWorktreeRemovals.get(record.worktreeId)?.failure?.message).toBe(
    'guest delete interrupted'
  )
})

it('does not run a recorded retry against a newly registered WSL checkout', async () => {
  kinds.set(checkout, 'directory')
  vi.mocked(listWorktreesStrict).mockImplementation(async (_path, options) =>
    options?.wslDistro
      ? [
          {
            path: checkout,
            head: 'def',
            branch: 'refs/heads/replacement',
            isMainWorktree: false,
            isBare: false
          }
        ]
      : []
  )
  let ran = false
  const result = retryFailedWorktreeRemoval(record.worktreeId, undefined, () => ({
    getLocalOptions: () => ({ wslDistro: 'Ubuntu' }),
    run: async () => {
      ran = true
      return {}
    },
    publish: () => {}
  }))
  await expect(result).rejects.toThrow('different checkout')
  await _settlePendingWorktreeRemovalsForTests()
  expect(ran).toBe(false)
})

it('leaves the failed removal retryable when its filesystem cannot be resolved', () => {
  expect(() =>
    retryFailedWorktreeRemoval(record.worktreeId, undefined, () => {
      throw new Error('Project runtime requires repair')
    })
  ).toThrow('Project runtime requires repair')
  expect(waitForPendingWorktreeRemoval(record.worktreeId)).toBeUndefined()
  expect(failedWorktreeRemovals.get(record.worktreeId)).toBe(record)
})

it('makes a startup removal retryable after its project runtime is repaired', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-wsl-removal-repair-'))
  const { failure: _failure, ...interrupted } = record
  failedWorktreeRemovals.clear()
  let needsRepair = true
  const jobFor = () => ({
    getLocalOptions: () => {
      if (needsRepair) {
        throw new Error('Project runtime requires repair')
      }
      return { wslDistro: 'Ubuntu' }
    },
    run: async () => {
      if (needsRepair) {
        throw new Error('Project runtime requires repair')
      }
      return {}
    },
    publish: () => {}
  })
  try {
    await writeWorktreeRemovalRecords(directory, () => [interrupted])
    await loadWorktreeRemovalRecords(directory)
    resumeInterruptedWorktreeRemovals(jobFor)
    await _settlePendingWorktreeRemovalsForTests()
    expect(waitForPendingWorktreeRemoval(record.worktreeId)).toBeUndefined()
    expect(failedWorktreeRemovals.get(record.worktreeId)?.failure?.message).toBe(
      'Project runtime requires repair'
    )
    expect(await readWorktreeRemovalRecords(directory)).toMatchObject([
      { failure: { message: 'Project runtime requires repair' } }
    ])
    needsRepair = false
    await expect(retryFailedWorktreeRemoval(record.worktreeId, undefined, jobFor)).resolves.toEqual(
      {}
    )
    await _settlePendingWorktreeRemovalsForTests()
    expect(waitForPendingWorktreeRemoval(record.worktreeId)).toBeUndefined()
    expect(failedWorktreeRemovals.has(record.worktreeId)).toBe(false)
    expect(await readWorktreeRemovalRecords(directory)).toEqual([])
  } finally {
    _resetPendingWorktreeRemovalsForTests()
    await rm(directory, { recursive: true, force: true })
  }
})
