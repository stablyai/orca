import { posix } from 'node:path'
import { throwIfSignalAborted } from '../../../shared/concurrency/abort-signal-reason'
import { runProcess } from '@orca/process-host'
import { lstat, stat, readFile, realpath } from 'node:fs/promises'
import { wslDistroForCommand } from '../../../shared/file-access/wsl-paths'
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
import { resolveWslInteropSpawnCwdAsync } from '../../wsl/execution/wsl-interop-spawn-directory'
import { describeWslProcessFailure } from '../../wsl/execution/wsl-process-failure'
import type { WorktreeProofAccess } from './worktree-orphan-gitdir-proof'

export type LocalWorktreeFilesystemOptions = {
  wslDistro?: string
}

export type CheckoutMarkerState =
  | { kind: 'absent' }
  | { kind: 'file'; identity: string }
  | { kind: 'other' }

export type RemoveLocalWorktreeMarkerOptions = {
  markerLast?: boolean
  expectedMarker?: string
  forbidAnyMarker?: boolean
}

const WSL_FILE_OPERATION_TIMEOUT_MS = 30_000

function resolveTargetWslDistro(
  targetPath: string | undefined,
  options: LocalWorktreeFilesystemOptions
): string | null {
  return wslDistroForCommand(targetPath, options.wslDistro?.trim() || undefined)
}

// Coreutils need no login shell; rc/motd output would corrupt parsed stdout.
async function runWslCommand(distro: string, command: string): Promise<string> {
  const result = await runProcess({
    program: 'wsl.exe',
    args: buildWslExecArgs(distro, ['sh', '-c', command]),
    // An inherited cwd may be the worktree currently being deleted (#16463).
    cwd: await resolveWslInteropSpawnCwdAsync(),
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

function isWslExitCode(error: unknown, exitCode: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'exitCode' in error &&
    error.exitCode === exitCode
  )
}

/** Paths as the filesystem that owns them spells them; drive paths ask their distro for the mount. */
export async function toLocalWorktreeRuntimePaths(
  targetPaths: readonly string[],
  options: LocalWorktreeFilesystemOptions = {},
  signal?: AbortSignal
): Promise<string[]> {
  const distro = resolveTargetWslDistro(targetPaths[0], options)
  return distro ? resolveWslGuestPaths(distro, targetPaths, signal) : [...targetPaths]
}

// Exit 2 keeps an unreadable drive mount apart from coreutils' missing-path exit 1.
function guestCommand(path: string, command: (target: string) => string): string {
  const { prelude, words } = wslGuestShellPaths([guestUncPath(path)], 2)
  return `${prelude}${command(words[0])}`
}

export function getLocalWorktreePathAccess(
  options: LocalWorktreeFilesystemOptions = {},
  targetPathHint?: string
): WorktreeProofAccess {
  const fallbackDistro = resolveTargetWslDistro(targetPathHint, options)
  const distroFor = (path: string) => resolveTargetWslDistro(path, options) ?? fallbackDistro
  if (process.platform !== 'win32' || (!fallbackDistro && !options.wslDistro?.trim())) {
    return {
      statPath: (path) => {
        const distro = distroFor(path)
        return distro ? createWslProofAccess(distro).statPath(path) : lstat(path)
      },
      layoutStatPath: (path) => {
        const distro = distroFor(path)
        return distro ? createWslProofAccess(distro).layoutStatPath(path) : stat(path)
      },
      readPath: (path) => {
        const distro = distroFor(path)
        return distro ? createWslProofAccess(distro).readPath(path) : readFile(path, 'utf8')
      },
      realPath: (path) => {
        const distro = distroFor(path)
        return distro ? createWslProofAccess(distro).realPath(path) : realpath(path)
      }
    }
  }
  return createWslProofAccess(fallbackDistro!)
}

function createWslProofAccess(distro: string): WorktreeProofAccess {
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

export async function readWslCheckoutMarkerState(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<CheckoutMarkerState | null> {
  const distro = resolveTargetWslDistro(targetPath, options)
  if (!distro) {
    return null
  }
  const stdout = await runWslCommand(
    distro,
    guestCommand(
      targetPath,
      (target) =>
        `orca_git=${target}/.git; orca_meta=$(LC_ALL=C stat -c '%F#%i' -- "$orca_git") && case "$orca_meta" in 'regular file#'*|'regular empty file#'*) printf 'file:%s\\n' "\${orca_meta#*#}" && LC_ALL=C head -n 1 "$orca_git" ;; *) printf 'other\\n' ;; esac`
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

const PARSE_ORCA_GITDIR_LINE =
  'orca_line=$(LC_ALL=C head -n 1 "$orca_target/.git") && ' +
  'orca_line="${orca_line%"${orca_line##*[![:space:]]}"}" && ' +
  'case "$orca_line" in [Gg][Ii][Tt][Dd][Ii][Rr]:*) orca_gitdir=${orca_line#*:}; orca_gitdir="${orca_gitdir#"${orca_gitdir%%[![:space:]]*}"}" ;; *) orca_gitdir="" ;; esac'

function buildWslMarkerLastScript(
  target: string,
  { expectedMarker, forbidAnyMarker = false }: RemoveLocalWorktreeMarkerOptions
): string {
  const expectedClause = forbidAnyMarker
    ? ' || true'
    : expectedMarker !== undefined
      ? ` || [ "$orca_gitdir#$orca_marker_ino" != ${quotePosixShell(expectedMarker)} ]`
      : ''
  // stat distinguishes ENOENT from EACCES; re-verify dev:ino and gitdir before rm -f .git, and never re-sweep before rmdir.
  return (
    `orca_target=${target}; ` +
    'orca_root_kind=$(LC_ALL=C stat -c \'%F\' -- "$orca_target") || exit $?; ' +
    'if [ "$orca_root_kind" != \'directory\' ]; then echo "Refusing to delete non-directory worktree path" >&2; exit 3; fi; ' +
    'if orca_meta=$(LC_ALL=C stat -c \'%F#%d:%i#%i\' -- "$orca_target/.git" 2>&1); then orca_has_git=1; ' +
    "else case \"$orca_meta\" in *': No such file or directory'|*': Not a directory') orca_has_git=0 ;; *) printf '%s\\n' \"$orca_meta\" >&2; exit 1 ;; esac; fi; " +
    'if [ "$orca_has_git" = 1 ]; then ' +
    "case \"$orca_meta\" in 'regular file#'*|'regular empty file#'*) ;; *) exit 4 ;; esac && " +
    'orca_rest=${orca_meta#*#} && orca_marker_id=${orca_rest%#*} && orca_marker_ino=${orca_rest#*#} && ' +
    `${PARSE_ORCA_GITDIR_LINE} && ` +
    `if [ -z "$orca_gitdir" ]${expectedClause}; then exit 4; fi && ` +
    'orca_saved_gitdir=$orca_gitdir && ' +
    'LC_ALL=C find "$orca_target" -mindepth 1 -maxdepth 1 ! -samefile "$orca_target/.git" -exec rm -rf -- {} + && ' +
    'if orca_after=$(LC_ALL=C stat -c \'%F#%d:%i\' -- "$orca_target/.git" 2>&1); then ' +
    "case \"$orca_after\" in 'regular file#'*|'regular empty file#'*) ;; *) exit 4 ;; esac && " +
    'if [ "${orca_after#*#}" != "$orca_marker_id" ]; then exit 4; fi && ' +
    `${PARSE_ORCA_GITDIR_LINE} && ` +
    'if [ "$orca_gitdir" != "$orca_saved_gitdir" ]; then exit 4; fi && ' +
    'LC_ALL=C rm -f -- "$orca_target/.git"; ' +
    "else case \"$orca_after\" in *': No such file or directory'|*': Not a directory') ;; *) printf '%s\\n' \"$orca_after\" >&2; exit 1 ;; esac; fi; " +
    'else ' +
    'LC_ALL=C find "$orca_target" -mindepth 1 -maxdepth 1 ! -iname .git -exec rm -rf -- {} + && ' +
    'if orca_after=$(LC_ALL=C stat -c \'%F\' -- "$orca_target/.git" 2>&1); then exit 4; ' +
    "else case \"$orca_after\" in *': No such file or directory'|*': Not a directory') ;; *) printf '%s\\n' \"$orca_after\" >&2; exit 1 ;; esac; fi; " +
    'fi && ' +
    'if ! LC_ALL=C rmdir -- "$orca_target"; then ' +
    'if LC_ALL=C stat -c \'%F\' -- "$orca_target/.git" >/dev/null 2>&1; then exit 4; fi; ' +
    'if [ -n "$(LC_ALL=C ls -A -- "$orca_target" 2>/dev/null)" ]; then exit 5; fi; ' +
    'exit 1; ' +
    'fi'
  )
}

/** `markerLast` keeps the entry `.git` resolves to (matched by identity, so a case-folding mount's `.GIT` stays too, and a differently cased sibling is removed first) until everything else is gone, so a failed delete still proves whose folder it is. */
export async function removeLocalWorktreePath(
  targetPath: string,
  options: LocalWorktreeFilesystemOptions = {},
  signal?: AbortSignal,
  markerOptions: RemoveLocalWorktreeMarkerOptions = {}
): Promise<void> {
  const { markerLast = false } = markerOptions
  const distro = resolveTargetWslDistro(targetPath, options)
  if (!distro) {
    throwIfSignalAborted(signal)
    await (markerLast
      ? removeUnregisteredHostCheckout(targetPath, signal, markerOptions)
      : removeHostTree(targetPath, { signal }))
    return
  }

  // Delete guest paths inside their distro; Windows Node cannot safely remove them.
  const inGuest = (script: (target: string) => string) =>
    runWslCommand(distro, guestCommand(targetPath, script))
  try {
    await inGuest((target) =>
      markerLast ? buildWslMarkerLastScript(target, markerOptions) : `rm -rf -- ${target}`
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
