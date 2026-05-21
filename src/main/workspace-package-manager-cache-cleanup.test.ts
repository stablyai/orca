/* eslint-disable max-lines -- Why: cache detection and cleanup regressions share one mocked SSH/runner setup. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IFilesystemProvider } from './providers/types'

const { commandExecFileAsyncMock, getSshGitProviderMock } = vi.hoisted(() => ({
  commandExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('./git/runner', () => ({
  commandExecFileAsync: commandExecFileAsyncMock
}))

vi.mock('./providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

import {
  buildPackageManagerCacheTargets,
  detectPackageManagersForDirectoryEntries,
  detectRemotePackageManagers,
  runPackageManagerCacheCleanup
} from './workspace-package-manager-cache-cleanup'

async function waitForCallCount(
  mock: { mock: { calls: unknown[] } },
  count: number
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (mock.mock.calls.length >= count) {
      return
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

describe('workspace package-manager cache cleanup', () => {
  let tempDir: string | null = null

  beforeEach(() => {
    commandExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    tempDir = null
  })

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  it('groups lockfile detections by target and CLI availability', async () => {
    commandExecFileAsyncMock.mockResolvedValue({ stdout: '10.0.0\n', stderr: '' })
    const detections = detectPackageManagersForDirectoryEntries({
      entryNames: ['package.json', 'pnpm-lock.yaml', 'package-lock.json'],
      connectionId: null,
      isRemote: false,
      repoDisplayName: 'orca',
      worktreeId: 'repo-1::/repo',
      worktreePath: '/repo'
    })

    const targets = await buildPackageManagerCacheTargets(detections)

    expect(targets).toHaveLength(2)
    expect(targets.map((target) => target.packageManager).sort()).toEqual(['npm', 'pnpm'])
    expect(targets.every((target) => target.cliAvailable)).toBe(true)
    expect(
      targets.map((target) => ({
        packageManager: target.packageManager,
        detectedWorktrees: target.detectedWorktrees
      }))
    ).toEqual([
      {
        packageManager: 'npm',
        detectedWorktrees: [{ worktreeId: 'repo-1::/repo', lockfiles: ['package-lock.json'] }]
      },
      {
        packageManager: 'pnpm',
        detectedWorktrees: [{ worktreeId: 'repo-1::/repo', lockfiles: ['pnpm-lock.yaml'] }]
      }
    ])
    expect(commandExecFileAsyncMock).toHaveBeenCalledWith(
      'pnpm',
      ['--version'],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(commandExecFileAsyncMock).toHaveBeenCalledWith(
      'npm',
      ['--version'],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(commandExecFileAsyncMock).not.toHaveBeenCalledWith(
      'pnpm',
      ['store', 'prune'],
      expect.anything()
    )
    expect(commandExecFileAsyncMock).not.toHaveBeenCalledWith(
      'npm',
      ['cache', 'clean', '--force'],
      expect.anything()
    )
  })

  it('marks detected package managers unavailable when the CLI is missing', async () => {
    commandExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('spawn pnpm ENOENT'), {
        code: 'ENOENT'
      })
    )

    const targets = await buildPackageManagerCacheTargets([
      {
        packageManager: 'pnpm',
        connectionId: null,
        isRemote: false,
        repoDisplayName: 'orca',
        worktreeId: 'repo-1::/repo',
        worktreePath: '/repo',
        lockfiles: ['pnpm-lock.yaml']
      }
    ])

    expect(targets[0]).toMatchObject({
      packageManager: 'pnpm',
      cliAvailable: false,
      unavailableReason:
        'pnpm was detected by lockfile, but its CLI was not available on this target.'
    })
  })

  it('keeps project-specific npm cache paths as separate cleanup targets', async () => {
    commandExecFileAsyncMock.mockImplementation(
      async (binary: string, args: string[], options: { cwd?: string }) => {
        if (binary === 'npm' && args.join(' ') === '--version') {
          return { stdout: '10.0.0\n', stderr: '' }
        }
        if (binary === 'npm' && args.join(' ') === 'config get cache') {
          return {
            stdout: options.cwd === '/repo-a' ? '/cache/a\n' : '/cache/b\n',
            stderr: ''
          }
        }
        throw new Error(`unexpected command ${binary} ${args.join(' ')}`)
      }
    )

    const targets = await buildPackageManagerCacheTargets([
      {
        packageManager: 'npm',
        connectionId: null,
        isRemote: false,
        repoDisplayName: 'repo-a',
        worktreeId: 'repo-a::/repo-a',
        worktreePath: '/repo-a',
        lockfiles: ['package-lock.json']
      },
      {
        packageManager: 'npm',
        connectionId: null,
        isRemote: false,
        repoDisplayName: 'repo-b',
        worktreeId: 'repo-b::/repo-b',
        worktreePath: '/repo-b',
        lockfiles: ['package-lock.json']
      }
    ])

    expect(targets).toHaveLength(2)
    expect(targets.map((target) => target.cachePath).sort()).toEqual(['/cache/a', '/cache/b'])
    expect(targets.map((target) => target.cwd).sort()).toEqual(['/repo-a', '/repo-b'])
  })

  it('propagates scan cancellation while checking local CLI availability', async () => {
    const signal = new AbortController().signal
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' })
    commandExecFileAsyncMock.mockRejectedValue(abortError)

    await expect(
      buildPackageManagerCacheTargets(
        [
          {
            packageManager: 'pnpm',
            connectionId: null,
            isRemote: false,
            repoDisplayName: 'orca',
            worktreeId: 'repo-1::/repo',
            worktreePath: '/repo',
            lockfiles: ['pnpm-lock.yaml']
          }
        ],
        { signal }
      )
    ).rejects.toBe(abortError)

    expect(commandExecFileAsyncMock).toHaveBeenCalledWith(
      'pnpm',
      ['--version'],
      expect.objectContaining({ cwd: '/repo', signal })
    )
  })

  it('detects remote lockfiles and checks the remote CLI through SSH', async () => {
    const provider = {
      readDir: vi.fn().mockResolvedValue([{ name: 'bun.lock' }])
    } as unknown as IFilesystemProvider
    const execNonInteractive = vi.fn().mockResolvedValue({
      stdout: '1.3.0\n',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })
    getSshGitProviderMock.mockReturnValue({ execNonInteractive })

    const detections = await detectRemotePackageManagers({
      provider,
      connectionId: 'ssh-1',
      repoDisplayName: 'remote',
      worktreeId: 'repo-remote::/remote/repo',
      worktreePath: '/remote/repo'
    })
    const targets = await buildPackageManagerCacheTargets(detections)

    expect(targets[0]).toMatchObject({
      packageManager: 'bun',
      connectionId: 'ssh-1',
      isRemote: true,
      cliAvailable: true
    })
    expect(execNonInteractive).toHaveBeenCalledWith(
      'bun',
      ['--version'],
      '/remote/repo',
      8000,
      undefined
    )
  })

  it('cancels remote CLI availability checks through the SSH relay', async () => {
    const controller = new AbortController()
    const execNonInteractive = vi.fn(
      () =>
        new Promise<never>(() => {
          // Keep the relay request pending until the scan cancellation wins.
        })
    )
    const cancelNonInteractiveExec = vi.fn().mockResolvedValue(undefined)
    getSshGitProviderMock.mockReturnValue({ execNonInteractive, cancelNonInteractiveExec })

    const promise = buildPackageManagerCacheTargets(
      [
        {
          packageManager: 'pnpm',
          connectionId: 'ssh-1',
          isRemote: true,
          repoDisplayName: 'remote',
          worktreeId: 'repo-remote::/remote/repo',
          worktreePath: '/remote/repo',
          lockfiles: ['pnpm-lock.yaml']
        }
      ],
      { signal: controller.signal }
    )
    await waitForCallCount(execNonInteractive, 1)
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(execNonInteractive).toHaveBeenCalledWith(
      'pnpm',
      ['--version'],
      '/remote/repo',
      8000,
      controller.signal
    )
    expect(cancelNonInteractiveExec).not.toHaveBeenCalled()
  })

  it('runs only known cleanup commands from a validated action id', async () => {
    commandExecFileAsyncMock.mockResolvedValue({
      stdout: 'Removed 1.2 GB\n',
      stderr: ''
    })

    const result = await runPackageManagerCacheCleanup({
      targetId: 'local:pnpm:%2Frepo',
      actionId: 'pnpm-store-prune',
      packageManager: 'pnpm',
      connectionId: null,
      cwd: '/repo'
    })

    expect(result).toMatchObject({ ok: true })
    expect(commandExecFileAsyncMock).toHaveBeenCalledWith(
      'pnpm',
      ['store', 'prune'],
      expect.objectContaining({ cwd: '/repo' })
    )

    await expect(
      runPackageManagerCacheCleanup({
        targetId: 'local:pnpm:%2Frepo',
        actionId: 'rm-rf-cache',
        packageManager: 'pnpm',
        connectionId: null,
        cwd: '/repo'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Unknown package-manager cache cleanup action.'
    })
  })

  it('measures pnpm store size before and after cleanup when possible', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-pnpm-store-'))
    const storePath = join(tempDir, 'store')
    const packagePath = join(storePath, 'v10', 'files')
    const packageFile = join(packagePath, 'pkg.tgz')
    await mkdir(packagePath, { recursive: true })
    await writeFile(packageFile, Buffer.alloc(4096, 1))
    commandExecFileAsyncMock.mockImplementation(async (binary: string, args: string[]) => {
      if (binary === 'pnpm' && args.join(' ') === 'store path') {
        return { stdout: `${storePath}\n`, stderr: '' }
      }
      if (binary === 'pnpm' && args.join(' ') === 'store prune') {
        await rm(packageFile, { force: true })
        return { stdout: 'Removed cached package\n', stderr: '' }
      }
      throw new Error(`unexpected command ${binary} ${args.join(' ')}`)
    })

    const result = await runPackageManagerCacheCleanup({
      targetId: 'local:pnpm:%2Frepo',
      actionId: 'pnpm-store-prune',
      packageManager: 'pnpm',
      connectionId: null,
      cwd: '/repo'
    })

    expect(result).toMatchObject({
      ok: true,
      cachePath: storePath
    })
    expect(result.ok && result.cacheSizeBeforeBytes).toBeGreaterThan(0)
    expect(result.ok && result.cacheSizeAfterBytes).toBeGreaterThanOrEqual(0)
    expect(result.ok && result.reclaimedBytes).toBeGreaterThan(0)
  })

  it('rejects malformed runtime cleanup requests before spawning commands', async () => {
    await expect(runPackageManagerCacheCleanup(undefined as never)).resolves.toEqual({
      ok: false,
      error: 'Invalid package-manager cache cleanup request.'
    })
    await expect(runPackageManagerCacheCleanup(null as never)).resolves.toEqual({
      ok: false,
      error: 'Invalid package-manager cache cleanup request.'
    })
    await expect(
      runPackageManagerCacheCleanup({
        targetId: 'local:pnpm:%2Frepo',
        actionId: 'pnpm-store-prune',
        packageManager: 'pnpm',
        connectionId: null,
        cwd: ''
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Invalid package-manager cache cleanup request.'
    })
    expect(commandExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
