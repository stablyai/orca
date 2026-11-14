import { posix } from 'node:path'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import { runProcess } from '@orca/process-host'
import { lstat, stat, readFile, realpath } from 'node:fs/promises'
import { buildWslExecArgs } from '../../../shared/wsl-login-shell-command'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { removeHostTree } from '../../filesystem/host-tree-removal'
import { toLinuxPath } from '../../../shared/wsl-paths'
import { resolveWslInteropSpawnCwd } from '../../wsl/execution/wsl-interop-spawn-directory'
import { describeWslProcessFailure } from '../../wsl/execution/wsl-process-failure'
import {
  assertWslAutomountSnapshotCurrent,
  captureWslAutomountSnapshot,
  ensureWslAutomountRoot,
  type WslAutomountSnapshot
} from '../../wsl/filesystem/wsl-automount-root'
import { isWindowsDrivePath, wslDrivePathForDistro } from '../../wsl/filesystem/wsl-drive-paths'
import type { WorktreeProofAccess } from './worktree-orphan-gitdir-proof'

export type LocalWorktreeFilesystemOptions = {
  wslDistro?: string
  signal?: AbortSignal
  proofEpoch?: WslAutomountSnapshot
}

export type LocalWorktreeFilesystem = {
  runtimePath: (path: string) => string
  access: WorktreeProofAccess
  remove: (path: string) => Promise<void>
  assertCurrent: () => void
  assertAuthorityCurrent: () => void
  statPathAfterRemoval: WorktreeProofAccess['statPath']
}

const WSL_FILE_OPERATION_TIMEOUT_MS = 30_000

function shouldUseWslFilesystem(options: LocalWorktreeFilesystemOptions): boolean {
  return process.platform === 'win32' && !!options.wslDistro?.trim()
}

// Coreutils need no login shell; rc/motd output would corrupt parsed stdout.
async function runWslCommand(
  distro: string,
  command: string,
  options: LocalWorktreeFilesystemOptions,
  assertCurrent: () => void,
  assertSuccessful: () => void = assertCurrent
): Promise<string> {
  assertCurrent()
  const result = await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, ['sh', '-c', command]),
    // An inherited cwd may be the worktree currently being deleted (#16463).
    cwd: resolveWslInteropSpawnCwd(),
    timeoutMs: WSL_FILE_OPERATION_TIMEOUT_MS,
    signal: options.signal
  }).catch((error: unknown) => {
    assertCurrent()
    throw error
  })
  if (result.code === 0 && result.signal === null && !result.timedOut) {
    assertSuccessful()
  } else {
    assertCurrent()
  }
  if (result.timedOut) {
    throw new Error(`WSL filesystem command timed out after ${WSL_FILE_OPERATION_TIMEOUT_MS}ms`)
  }
  if (result.code !== 0 || result.signal !== null) {
    throw Object.assign(new Error(describeWslProcessFailure(result)), {
      exitCode: result.code,
      stderr: result.stderr
    })
  }
  return result.stdout
}

// LC_ALL=C fixes strerror text; match only its tail because GNU and BusyBox use different verbs.
const WSL_MISSING_PATH_STDERR = /: (?:No such file or directory|Not a directory)\r?\n?$/

function isWslMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('exitCode' in error)) {
    return false
  }
  const stderr = 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : ''
  return error.exitCode === 1 && WSL_MISSING_PATH_STDERR.test(stderr)
}

export async function prepareLocalWorktreeFilesystem(
  knownPaths: readonly string[],
  options: LocalWorktreeFilesystemOptions = {}
): Promise<LocalWorktreeFilesystem> {
  const distro = shouldUseWslFilesystem(options) ? options.wslDistro?.trim() : undefined
  const assertProofCurrent = (): void => {
    if (distro && options.proofEpoch) {
      assertWslAutomountSnapshotCurrent(options.proofEpoch)
    }
  }
  throwIfSignalAborted(options.signal)
  assertProofCurrent()
  if (distro && knownPaths.some(isWindowsDrivePath)) {
    await ensureWslAutomountRoot(distro, options.signal)
    throwIfSignalAborted(options.signal)
    assertProofCurrent()
  }
  const snapshot = distro ? captureWslAutomountSnapshot(distro) : undefined
  const assertAuthorityCurrent = (): void => {
    assertProofCurrent()
    if (snapshot) {
      assertWslAutomountSnapshotCurrent(snapshot)
    }
  }
  const assertCurrent = (): void => {
    throwIfSignalAborted(options.signal)
    assertAuthorityCurrent()
  }
  const runtimePath = (path: string): string =>
    distro ? (wslDrivePathForDistro(path, distro, snapshot) ?? toLinuxPath(path)) : path
  const filesystem: LocalWorktreeFilesystem = {
    runtimePath,
    assertCurrent,
    assertAuthorityCurrent,
    access: getLocalWorktreePathAccess(options, runtimePath, assertCurrent),
    statPathAfterRemoval: getLocalWorktreePathAccess(
      { ...options, signal: undefined },
      runtimePath,
      assertAuthorityCurrent
    ).statPath,
    remove: (path) => removeLocalWorktreePath(path, options, options.signal, filesystem)
  }
  assertCurrent()
  return filesystem
}

function getLocalWorktreePathAccess(
  options: LocalWorktreeFilesystemOptions,
  runtimePath: (path: string) => string,
  assertCurrent: () => void
): WorktreeProofAccess {
  const distro = options.wslDistro?.trim()
  if (!shouldUseWslFilesystem(options) || !distro) {
    return {
      statPath: lstat,
      layoutStatPath: stat,
      readPath: (path) => readFile(path, 'utf8'),
      realPath: realpath
    }
  }

  const inspect = (path: string, command: string) =>
    runWslCommand(distro, command, options, assertCurrent).catch((error: unknown) => {
      if (isWslMissingPathError(error)) {
        throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
      }
      throw error
    })
  const statPath = async (path: string, follow: boolean) => {
    const target = quotePosixShell(runtimePath(path))
    // Shell file tests conflate permission failures with absence; stat preserves the reason.
    const stdout = await inspect(path, `LC_ALL=C stat ${follow ? '-L ' : ''}-c %F -- ${target}`)
    const kind = stdout.trim()
    return {
      type:
        kind === 'symbolic link'
          ? 'symlink'
          : kind === 'regular file' || kind === 'regular empty file'
            ? 'file'
            : kind === 'directory'
              ? 'directory'
              : 'other'
    }
  }
  return {
    statPath: (path) => statPath(path, false),
    layoutStatPath: (path) => statPath(path, true),
    realPath: async (path) => {
      const target = quotePosixShell(runtimePath(path))
      const stdout = await inspect(path, `LC_ALL=C realpath -e -- ${target}`)
      const resolved = stdout.replace(/\r?\n$/, '')
      if (!posix.isAbsolute(resolved) || /[\0\r\n]/.test(resolved)) {
        throw new Error('Invalid WSL canonical path')
      }
      return resolved
    },
    readPath: async (path) => {
      const target = quotePosixShell(runtimePath(path))
      const stdout = await inspect(path, `LC_ALL=C cat -- ${target}`)
      return stdout
    }
  }
}

export async function removeLocalWorktreePath(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {},
  signal: AbortSignal | undefined = options.signal,
  filesystem?: LocalWorktreeFilesystem
): Promise<void> {
  const scope =
    filesystem ?? (await prepareLocalWorktreeFilesystem([targetPath], { ...options, signal }))
  scope.assertCurrent()
  const distro = options.wslDistro?.trim()
  if (!shouldUseWslFilesystem(options) || !distro) {
    throwIfSignalAborted(signal)
    await removeHostTree(targetPath, { signal }).catch((error: unknown) => {
      scope.assertCurrent()
      throw error
    })
    scope.assertAuthorityCurrent()
    return
  }

  // Delete guest paths inside their distro; Windows Node cannot safely remove them.
  await runWslCommand(
    distro,
    `rm -rf -- ${quotePosixShell(scope.runtimePath(targetPath))}`,
    { ...options, signal },
    scope.assertCurrent,
    scope.assertAuthorityCurrent
  )
}
