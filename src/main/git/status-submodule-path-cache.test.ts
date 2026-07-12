import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileAsyncBufferMock, gitStreamStdoutMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileAsyncBufferMock: vi.fn(),
    gitStreamStdoutMock: vi.fn()
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: gitExecFileAsyncBufferMock,
  gitStreamStdout: gitStreamStdoutMock,
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => ({
    ...env,
    GIT_OPTIONAL_LOCKS: '0'
  })
}))

import {
  MAX_SUBMODULE_PATHS_CACHE_ENTRIES,
  abortMerge,
  abortRebase,
  clearSubmodulePathsCacheForTests,
  getSubmodulePathsCacheCountForTests,
  listSubmodulePaths
} from './status'
import { checkoutBranch } from './checkout'
import { gitPull, gitPullRebaseFromBase } from './remote'
import { addWorktree, removeWorktree } from './worktree'

describe('submodule path cache', () => {
  beforeEach(() => {
    clearSubmodulePathsCacheForTests()
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    gitStreamStdoutMock.mockReset()
    gitExecFileAsyncMock.mockImplementation((_args: string[], options?: { cwd?: string }) =>
      Promise.resolve({
        stdout: `submodule.lib.path ${String(options?.cwd ?? 'repo').replace(/^.*[/\\\\]/, '')}-lib\n`
      })
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    clearSubmodulePathsCacheForTests()
  })

  it('prunes expired entries even when later reads use different worktrees', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    await listSubmodulePaths('/repo-a')
    await listSubmodulePaths('/repo-b')

    expect(getSubmodulePathsCacheCountForTests()).toBe(2)

    vi.setSystemTime(5_001)
    await expect(listSubmodulePaths('/repo-c')).resolves.toEqual(['repo-c-lib'])

    expect(getSubmodulePathsCacheCountForTests()).toBe(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('stays bounded through prolonged worktree churn and keeps recently reused worktrees', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)

    for (let wave = 0; wave < 4; wave += 1) {
      for (let i = 0; i < MAX_SUBMODULE_PATHS_CACHE_ENTRIES; i += 1) {
        await listSubmodulePaths(`/wave-${wave}-repo-${i}`)
      }
      expect(getSubmodulePathsCacheCountForTests()).toBe(MAX_SUBMODULE_PATHS_CACHE_ENTRIES)
      vi.advanceTimersByTime(5_001)
    }

    await expect(listSubmodulePaths('/retained-repo')).resolves.toEqual(['retained-repo-lib'])
    for (let i = 0; i < MAX_SUBMODULE_PATHS_CACHE_ENTRIES - 1; i += 1) {
      await listSubmodulePaths(`/final-repo-${i}`)
    }
    await expect(listSubmodulePaths('/retained-repo')).resolves.toEqual(['retained-repo-lib'])
    await listSubmodulePaths(`/final-repo-${MAX_SUBMODULE_PATHS_CACHE_ENTRIES - 1}`)
    await listSubmodulePaths('/overflow-repo')

    expect(getSubmodulePathsCacheCountForTests()).toBe(MAX_SUBMODULE_PATHS_CACHE_ENTRIES)

    const callsBeforeRetainedRead = gitExecFileAsyncMock.mock.calls.length
    await expect(listSubmodulePaths('/retained-repo')).resolves.toEqual(['retained-repo-lib'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(callsBeforeRetainedRead)

    await expect(listSubmodulePaths('/final-repo-0')).resolves.toEqual(['final-repo-0-lib'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(callsBeforeRetainedRead + 1)
  })

  it('does not let a pre-invalidation read repopulate the cache', async () => {
    let resolveOldRead: ((value: { stdout: string }) => void) | undefined
    gitExecFileAsyncMock.mockImplementationOnce(
      () =>
        new Promise<{ stdout: string }>((resolve) => {
          resolveOldRead = resolve
        })
    )

    const oldRead = listSubmodulePaths('/repo')
    expect(resolveOldRead).toBeTypeOf('function')
    clearSubmodulePathsCacheForTests()
    resolveOldRead?.({ stdout: 'submodule.lib.path old-lib\n' })

    await expect(oldRead).resolves.toEqual(['old-lib'])
    expect(getSubmodulePathsCacheCountForTests()).toBe(0)
    await expect(listSubmodulePaths('/repo')).resolves.toEqual(['repo-lib'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it("does not reuse another branch's submodule paths after local or WSL checkout", async () => {
    let modulePath = 'main-lib'
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'checkout') {
        modulePath = 'feature-lib'
        return Promise.resolve({ stdout: '' })
      }
      return Promise.resolve({ stdout: `submodule.lib.path ${modulePath}\n` })
    })
    const runtime = { wslDistro: 'Ubuntu' }

    await expect(listSubmodulePaths('/repo', runtime)).resolves.toEqual(['main-lib'])
    await checkoutBranch('/repo', 'feature', runtime)
    await expect(listSubmodulePaths('/repo', runtime)).resolves.toEqual(['feature-lib'])

    const configReads = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => args[0] === 'config' && args.includes('.gitmodules')
    )
    expect(configReads).toHaveLength(2)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['checkout', 'feature', '--'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu'
    })
  })

  it.each([
    ['pull', () => gitPull('/repo')],
    ['rebase', () => gitPullRebaseFromBase('/repo', 'origin/main')]
  ])('invalidates submodule paths around local %s', async (_name, mutate) => {
    let modulePath = 'old-lib'
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'pull') {
        modulePath = 'fresh-lib'
        return Promise.resolve({ stdout: '' })
      }
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return Promise.resolve({ stdout: `submodule.lib.path ${modulePath}\n` })
      }
      return Promise.resolve({ stdout: '' })
    })

    await expect(listSubmodulePaths('/repo')).resolves.toEqual(['old-lib'])
    await mutate()
    await expect(listSubmodulePaths('/repo')).resolves.toEqual(['fresh-lib'])

    const configReads = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => args[0] === 'config' && args.includes('.gitmodules')
    )
    expect(configReads).toHaveLength(2)
  })

  it.each([
    ['merge', () => abortMerge('/repo', { wslDistro: 'Ubuntu' })],
    ['rebase', () => abortRebase('/repo', { wslDistro: 'Ubuntu' })]
  ])('drops a cached empty .gitmodules result when %s abort restores it', async (_name, abort) => {
    let modulePath = ''
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[1] === '--abort') {
        modulePath = 'restored-lib'
        return Promise.resolve({ stdout: '' })
      }
      return Promise.resolve({
        stdout: modulePath ? `submodule.lib.path ${modulePath}\n` : ''
      })
    })

    await expect(listSubmodulePaths('/repo', { wslDistro: 'Ubuntu' })).resolves.toEqual([])
    await abort()
    await expect(listSubmodulePaths('/repo', { wslDistro: 'Ubuntu' })).resolves.toEqual([
      'restored-lib'
    ])

    const configReads = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => args[0] === 'config' && args.includes('.gitmodules')
    )
    expect(configReads).toHaveLength(2)
  })

  it('drops a same-path negative cache when a local or WSL worktree is recreated', async () => {
    let recreated = false
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'worktree' && args[1] === 'add') {
        recreated = true
      }
      if (args[0] === 'config' && args.includes('.gitmodules')) {
        return Promise.resolve({
          stdout: recreated ? 'submodule.lib.path recreated-lib\n' : ''
        })
      }
      return Promise.resolve({ stdout: '' })
    })
    const runtime = { wslDistro: 'Ubuntu' }

    await expect(listSubmodulePaths('/repo-feature', runtime)).resolves.toEqual([])
    await removeWorktree('/repo', '/repo-feature', true, {
      ...runtime,
      knownRemovedWorktree: { branch: '', head: '', locked: false }
    })
    await addWorktree('/repo', '/repo-feature', 'feature', undefined, false, false, {
      ...runtime,
      checkoutExistingBranch: true
    })
    await expect(listSubmodulePaths('/repo-feature', runtime)).resolves.toEqual(['recreated-lib'])

    const configReads = gitExecFileAsyncMock.mock.calls.filter(
      ([args]) => args[0] === 'config' && args.includes('.gitmodules')
    )
    expect(configReads).toHaveLength(2)
  })
})
