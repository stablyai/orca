import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const readWslDistroRunningStateMock = vi.hoisted(() => vi.fn())
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWslDistroRunningState: readWslDistroRunningStateMock
}))

import { RuntimeGitStatusCommands } from './runtime-git-status-commands'
import { RuntimeGitSyncCommands } from './runtime-git-sync-commands'
import { RuntimeGitDiffCommands } from './runtime-git-diff-commands'
import { RuntimeFileAccess } from './files/file-access'
import { RuntimeFileReads } from './files/file-reads'
import { RuntimeFileWatches } from './files/watch/file-watches'
import type { RuntimeGitCommandHost, RuntimeGitTarget } from './runtime-git-command-target'
import { WslDistroStoppedError } from '../wsl/wsl-unc-access-gate'
import { mapRuntimeError } from './rpc/errors'

const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
const HOST_ROOT = 'C:\\src\\repo'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function gitHost(target: Omit<RuntimeGitTarget, 'worktree'> & { path: string }) {
  const resolveRuntimeGitTarget = vi.fn(async () => ({
    ...target,
    worktree: { id: 'wt-1', repoId: 'repo-1', path: target.path, git: {} }
  }))
  const host = { resolveRuntimeGitTarget }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These reads call only resolveRuntimeGitTarget before the gate decides.
  return host as unknown as RuntimeGitCommandHost
}

function statusCommands(
  target: Omit<RuntimeGitTarget, 'worktree'> & { path: string }
): RuntimeGitStatusCommands {
  return new RuntimeGitStatusCommands(gitHost(target))
}

function fileHost(): never {
  const host = {
    getRuntimeId: () => 'runtime-1',
    requireStore: () => ({ getRepos: () => [] }),
    resolveRuntimeFileTarget: async () => ({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: UNC_ROOT, git: {} },
      executionHostId: 'local'
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: These reads call only these members before the gate decides.
  return host as never
}

// verify G7: phones, web and the CLI polled Git followers while the desktop IPC twins were gated.
describe('runtime RPC Git followers for a stopped WSL distro', () => {
  beforeEach(() => {
    readWslDistroRunningStateMock.mockReset().mockResolvedValue('stopped')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  const uncHost = (): RuntimeGitCommandHost => gitHost({ path: UNC_ROOT, executionHostId: 'local' })
  const unc = (): RuntimeGitStatusCommands => new RuntimeGitStatusCommands(uncHost())

  it.each([
    ['git.submoduleStatus', () => unc().getRuntimeGitSubmoduleStatus('id:wt-1', 'vendor')],
    ['git.checkIgnored', () => unc().checkRuntimeGitIgnoredPaths('id:wt-1', ['dist'])],
    ['git.history', () => unc().getRuntimeGitHistory('id:wt-1')],
    ['git.conflictOperation', () => unc().getRuntimeGitConflictOperation('id:wt-1')],
    ['git.mutationInFlight', () => unc().getRuntimeGitMutationInFlight('id:wt-1')],
    [
      'git.upstreamStatus',
      () => new RuntimeGitSyncCommands(uncHost()).getRuntimeGitUpstreamStatus('id:wt-1')
    ],
    [
      'files.pathsExist',
      () => new RuntimeFileAccess(fileHost()).pathsExistRuntimeFiles('id:wt-1', ['a.ts'])
    ]
  ])('%s refuses before touching the distro', async (_method, read) => {
    await expect(read()).rejects.toBeInstanceOf(WslDistroStoppedError)
    expect(readWslDistroRunningStateMock).toHaveBeenCalledWith('Ubuntu', expect.anything())
  })

  // Explicit taps, browsing and opened views are user acts: they never ask the gate.
  it.each([
    [
      'git.diff',
      () => new RuntimeGitDiffCommands(uncHost()).getRuntimeGitDiff('id:wt-1', 'a.ts', false)
    ],
    [
      'git.branchCompare',
      () => new RuntimeGitDiffCommands(uncHost()).getRuntimeGitBranchCompare('id:wt-1', 'main')
    ],
    ['files.read', () => new RuntimeFileReads(fileHost()).readMobileFile('id:wt-1', 'a.ts')],
    [
      'files.readPreview',
      () => new RuntimeFileReads(fileHost()).readFileExplorerPreview('id:wt-1', 'a.ts')
    ],
    ['files.readDir', () => new RuntimeFileWatches(fileHost()).readFileExplorerDir('id:wt-1', '')],
    ['files.stat', () => new RuntimeFileAccess(fileHost()).statRuntimeFile('id:wt-1', 'a.ts')]
  ])('%s stays a user act', async (_method, read) => {
    await read().catch((error: unknown) => expect(error).not.toBeInstanceOf(WslDistroStoppedError))
    expect(readWslDistroRunningStateMock).not.toHaveBeenCalled()
  })

  it("keeps git.status as a viewing client's implicit wake", async () => {
    await unc()
      .getRuntimeGitStatus('id:wt-1')
      .catch((error: unknown) => expect(error).not.toBeInstanceOf(WslDistroStoppedError))
    expect(readWslDistroRunningStateMock).not.toHaveBeenCalled()
  })

  it('refuses a Windows-path repo whose Git runs in a stopped distro', async () => {
    const commands = statusCommands({
      path: HOST_ROOT,
      executionHostId: 'local',
      localGitOptions: { wslDistro: 'Ubuntu' }
    })
    await expect(commands.getRuntimeGitHistory('id:wt-1')).rejects.toBeInstanceOf(
      WslDistroStoppedError
    )
  })

  it('never asks WSL for an SSH host', async () => {
    const commands = statusCommands({ path: UNC_ROOT, executionHostId: 'ssh:builder' })
    await expect(commands.getRuntimeGitHistory('id:wt-1')).rejects.not.toBeInstanceOf(
      WslDistroStoppedError
    )
    expect(readWslDistroRunningStateMock).not.toHaveBeenCalled()
  })

  it('reaches older clients as the runtime_error they already show', () => {
    const response = mapRuntimeError(
      'req-1',
      { runtimeId: 'runtime-1' },
      new WslDistroStoppedError('Ubuntu')
    )
    expect(response.error).toEqual({
      code: 'runtime_error',
      message: "WSL distro 'Ubuntu' is not running. Retry, or open a terminal in it, to start it."
    })
  })
})
