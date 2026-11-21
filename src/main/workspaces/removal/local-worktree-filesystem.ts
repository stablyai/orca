import { posix } from 'node:path'
import { throwIfSignalAborted } from '../../../shared/concurrency/abort-signal-reason'
import { runProcess } from '@orca/process-host'
import { lstat, stat, readFile, realpath } from 'node:fs/promises'
import { parseGitdirMarkerPayload } from '../../../shared/git/metadata/gitdir-marker-payload'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import { buildWslExecArgs } from '../../../shared/shell/wsl/wsl-login-shell-command'
import {
  differentCheckoutAtPathError,
  unregisteredFolderRefusal
} from '../../../shared/worktree/removal/removal'
import { removeHostTree, removeUnregisteredHostCheckout } from '../../filesystem/host-tree-removal'
import {
  guestUncPath,
  resolveWslGuestPaths,
  wslGuestShellPaths
} from '../../wsl/filesystem/wsl-guest-drive-path'
import { resolveWslInteropSpawnCwd } from '../../wsl/execution/wsl-interop-spawn-directory'
import { describeWslProcessFailure } from '../../wsl/execution/wsl-process-failure'
import type { WorktreeProofAccess } from './worktree-orphan-gitdir-proof'

export type LocalWorktreeFilesystemOptions = {
  wslDistro?: string
}

const WSL_FILE_OPERATION_TIMEOUT_MS = 30_000

function shouldUseWslFilesystem(options: LocalWorktreeFilesystemOptions): boolean {
  return process.platform === 'win32' && !!options.wslDistro?.trim()
}

// Coreutils need no login shell; rc/motd output would corrupt parsed stdout.
async function runWslCommand(distro: string, command: string): Promise<string> {
  const result = await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, ['sh', '-c', command]),
    // An inherited cwd may be the worktree currently being deleted (#16463).
    cwd: resolveWslInteropSpawnCwd(),
    timeoutMs: WSL_FILE_OPERATION_TIMEOUT_MS
  })
  if (result.timedOut) {
    throw new Error(`WSL filesystem command timed out after ${WSL_FILE_OPERATION_TIMEOUT_MS}ms`)
  }
  if (result.code !== 0) {
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

/** Paths as the filesystem that owns them spells them; drive paths ask their distro for the mount. */
export async function toLocalWorktreeRuntimePaths(
  targetPaths: readonly string[],
  options: LocalWorktreeFilesystemOptions = {},
  signal?: AbortSignal
): Promise<string[]> {
  const distro = options.wslDistro?.trim()
  return shouldUseWslFilesystem(options) && distro
    ? resolveWslGuestPaths(distro, targetPaths, signal)
    : [...targetPaths]
}

// Exit 2 keeps an unreadable drive mount apart from coreutils' missing-path exit 1.
function guestCommand(path: string, command: (target: string) => string): string {
  const { prelude, words } = wslGuestShellPaths([guestUncPath(path)], 2)
  return `${prelude}${command(words[0])}`
}

export function getLocalWorktreePathAccess(
  options: LocalWorktreeFilesystemOptions = {}
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
    runWslCommand(distro, command).catch((error: unknown) => {
      if (isWslMissingPathError(error)) {
        throw Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
      }
      throw error
    })
  const statPath = async (path: string, follow: boolean) => {
    // Shell file tests conflate permission failures with absence; stat preserves the reason.
    const stdout = await inspect(
      path,
      guestCommand(path, (target) => `LC_ALL=C stat ${follow ? '-L ' : ''}-c %F -- ${target}`)
    )
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
      const stdout = await inspect(
        path,
        guestCommand(path, (target) => `LC_ALL=C realpath -e -- ${target}`)
      )
      const resolved = stdout.replace(/\r?\n$/, '')
      if (!posix.isAbsolute(resolved) || /[\0\r\n]/.test(resolved)) {
        throw new Error('Invalid WSL canonical path')
      }
      return resolved
    },
    readPath: async (path) => {
      return inspect(
        path,
        guestCommand(path, (target) => `LC_ALL=C cat -- ${target}`)
      )
    }
  }
}

export type CheckoutMarkerState =
  | { kind: 'absent' }
  | { kind: 'file'; identity: string }
  | { kind: 'other' }

function isWslExitCode(error: unknown, exitCode: number): boolean {
  return typeof error === 'object' && error !== null && 'exitCode' in error && error.exitCode === exitCode
}

export async function readWslCheckoutMarkerState(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<CheckoutMarkerState | null> {
  const distro = options.wslDistro?.trim()
  if (!shouldUseWslFilesystem(options) || !distro) {
    return null
  }
  const stdout = await runWslCommand(
    distro,
    guestCommand(
      targetPath,
      (target) =>
        `orca_git=${target}/.git; if [ ! -e "$orca_git" ] && [ ! -L "$orca_git" ]; then printf 'absent\\n'; elif [ -L "$orca_git" ] || [ ! -f "$orca_git" ]; then printf 'other\\n'; else LC_ALL=C stat -c 'file:%i' -- "$orca_git" && { IFS= read -r orca_line < "$orca_git" || [ -n "$orca_line" ] || orca_line=""; printf '%s\\n' "$orca_line"; }; fi`
    )
  ).catch((error: unknown) => {
    if (isWslMissingPathError(error)) {
      return 'absent\n'
    }
    throw error
  })
  const newline = stdout.indexOf('\n')
  const header = (newline === -1 ? stdout : stdout.slice(0, newline)).replace(/\r$/, '')
  if (header === 'absent') {
    return { kind: 'absent' }
  }
  if (!header.startsWith('file:')) {
    return { kind: 'other' }
  }
  const ino = header.slice('file:'.length).trim()
  const rest = newline === -1 ? '' : stdout.slice(newline + 1)
  const gitdir = parseGitdirMarkerPayload(rest)
  return ino && gitdir ? { kind: 'file', identity: `${gitdir}#${ino}` } : { kind: 'other' }
}

function buildWslMarkerLastScript(target: string, expectedMarker?: string): string {
  const expectedClause =
    expectedMarker !== undefined
      ? ` || [ "$orca_gitdir#$orca_marker_ino" != ${quotePosixShell(expectedMarker)} ]`
      : ''
  // Sweep children once, recheck the marker's dev:ino before unlinking it, and never re-sweep before rmdir.
  return (
    `orca_target=${target}; ` +
    'if [ ! -e "$orca_target" ] && [ ! -L "$orca_target" ]; then exit 0; fi; ' +
    'if [ -L "$orca_target" ] || [ ! -d "$orca_target" ]; then echo "Refusing to delete non-directory worktree path" >&2; exit 3; fi; ' +
    'if [ -e "$orca_target/.git" ] || [ -L "$orca_target/.git" ]; then ' +
    'if [ -L "$orca_target/.git" ] || [ ! -f "$orca_target/.git" ]; then exit 4; fi && ' +
    'orca_stat=$(LC_ALL=C stat -c \'%d:%i#%i\' -- "$orca_target/.git") && ' +
    'orca_marker_id=${orca_stat%#*} && ' +
    'orca_marker_ino=${orca_stat#*#} && ' +
    '{ IFS= read -r orca_line < "$orca_target/.git" || [ -n "$orca_line" ] || orca_line=""; } && ' +
    'orca_line="${orca_line%"${orca_line##*[![:space:]]}"}" && ' +
    'case "$orca_line" in [Gg][Ii][Tt][Dd][Ii][Rr]:*) orca_gitdir=${orca_line#*:}; orca_gitdir="${orca_gitdir#"${orca_gitdir%%[![:space:]]*}"}" ;; *) orca_gitdir="" ;; esac && ' +
    `if [ -z "$orca_gitdir" ]${expectedClause}; then exit 4; fi && ` +
    'LC_ALL=C find "$orca_target" -mindepth 1 -maxdepth 1 ! -samefile "$orca_target/.git" -exec rm -rf -- {} + && ' +
    'if [ -e "$orca_target/.git" ] || [ -L "$orca_target/.git" ]; then ' +
    'if [ -L "$orca_target/.git" ] || [ ! -f "$orca_target/.git" ] || [ "$(LC_ALL=C stat -c \'%d:%i\' -- "$orca_target/.git" 2>/dev/null)" != "$orca_marker_id" ]; then exit 4; fi && ' +
    'LC_ALL=C rm -f -- "$orca_target/.git"; ' +
    'fi; ' +
    'else ' +
    'LC_ALL=C find "$orca_target" -mindepth 1 -maxdepth 1 ! -iname .git -exec rm -rf -- {} + && ' +
    'if [ -e "$orca_target/.git" ] || [ -L "$orca_target/.git" ]; then exit 4; fi; ' +
    'fi && ' +
    'if ! LC_ALL=C rmdir -- "$orca_target"; then ' +
    'if [ -e "$orca_target/.git" ] || [ -L "$orca_target/.git" ]; then exit 4; fi; ' +
    'if [ -d "$orca_target" ] && [ -n "$(LC_ALL=C ls -A -- "$orca_target" 2>/dev/null)" ]; then exit 5; fi; ' +
    'exit 1; ' +
    'fi'
  )
}

/** `markerLast` keeps the entry `.git` resolves to (matched by identity, so a case-folding mount's `.GIT` stays too, and a differently cased sibling is removed first) until everything else is gone, so a failed delete still proves whose folder it is. */
export async function removeLocalWorktreePath(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {},
  signal?: AbortSignal,
  { markerLast = false, expectedMarker }: { markerLast?: boolean; expectedMarker?: string } = {}
): Promise<void> {
  const distro = options.wslDistro?.trim()
  if (!shouldUseWslFilesystem(options) || !distro) {
    throwIfSignalAborted(signal)
    await (markerLast
      ? removeUnregisteredHostCheckout(targetPath, signal, expectedMarker)
      : removeHostTree(targetPath, { signal }))
    return
  }

  // Delete guest paths inside their distro; Windows Node cannot safely remove them.
  const inGuest = (script: (target: string) => string) =>
    runWslCommand(distro, guestCommand(targetPath, script))
  try {
    await inGuest((target) =>
      markerLast ? buildWslMarkerLastScript(target, expectedMarker) : `rm -rf -- ${target}`
    )
  } catch (error) {
    if (markerLast && isWslExitCode(error, 4)) {
      throw differentCheckoutAtPathError(targetPath)
    }
    if (markerLast && isWslExitCode(error, 5)) {
      throw unregisteredFolderRefusal(targetPath)
    }
    // Only a definitive "No such file" means done; permission errors must not read as removed.
    if (!markerLast || !isWslMissingPathError(error)) {
      throw error
    }
    // A child (the marker) vanishing mid-command also reads as missing; only an absent root is done.
    const rootStillPresent = await inGuest((target) => `LC_ALL=C stat -c %F -- ${target}`).then(
      () => true,
      (statError: unknown) => !isWslMissingPathError(statError)
    )
    if (rootStillPresent) {
      throw error
    }
  }
}
