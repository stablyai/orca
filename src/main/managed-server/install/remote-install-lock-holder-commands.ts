import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import type { InstallLockOwnerFile } from './remote-install-lock-commands'

/** Inside the mkdir lock: shared-flocked by the owner's holder and every fenced command; its
 * content marks the lock flock-backed. Old builds never write it, so their locks keep today's rules. */
export const INSTALL_LOCK_HOLDER_FILENAME = '.holder-flock'
// The holder's pid, so an owner that gave up on it can stop it before it marks the lock late.
const HOLDER_PID_FILENAME = '.holder-pid'
// In the holder's own command line beside its token, so a kill can check the pid is still that holder.
const HOLDER_ARGV_TAG = 'orca-install-lock-holder'
const HOLDER_MARKER = 'held'
/** Exit status of a fenced command whose lock another owner now holds. */
export const INSTALL_LOCK_FENCE_EXIT_CODE = 75

export const INSTALL_LOCK_HOLDER_READY = 'HOLDER_READY'
export const INSTALL_LOCK_HOLDER_MARK = 'mark'
export const INSTALL_LOCK_HOLDER_HELD = 'HOLDER_HELD'
const HOLDER_EXITED = 'HOLDER_EXITED'
const INSTALL_LOCK_RELEASE_BUSY = 'INSTALL_LOCK_RELEASE_BUSY'
// Busybox flock has no -w, so shared waits poll; a contender's exclusive probe is momentary.
const SHARED_LOCK_ATTEMPTS = 10

/** Identifies one lock generation: the lock dir's mtime:inode plus the token its owner wrote. */
export type InstallLockHolderExit = { dirKey: string; token: string }

function holderPath(lockDir: string): string {
  return `${lockDir.replace(/\/+$/u, '')}/${INSTALL_LOCK_HOLDER_FILENAME}`
}

function ownerPath(lockDir: string, ownerFileName: string): string {
  return `${lockDir.replace(/\/+$/u, '')}/${ownerFileName}`
}

function lockLoop(fd: number, mode: '-s' | '-x', giveUp: string): string {
  return (
    `held_tries=0; until flock ${mode} -n ${fd} 2>/dev/null; do held_tries=$((held_tries + 1)); ` +
    `[ "$held_tries" -ge ${SHARED_LOCK_ATTEMPTS} ] && ${giveUp}; sleep 1; done;`
  )
}

function sharedLockLoop(fd: number): string {
  return lockLoop(fd, '-s', `exit ${INSTALL_LOCK_FENCE_EXIT_CODE}`)
}

/** Long-lived POSIX holder of a shared kernel lock inside `lockDir`, kept until its stdin closes.
 * It marks the lock only after the desktop answers READY, so a holder the desktop gave up on
 * (stdin closed) can never leave a marker behind. */
export function installLockHolderCommand(lockDir: string, owner: InstallLockOwnerFile): string {
  const ownerFile = quotePosixShell(`./${owner.fileName}`)
  const token = quotePosixShell(owner.token)
  const holder = quotePosixShell(`./${INSTALL_LOCK_HOLDER_FILENAME}`)
  const ownsLock = `[ "$(cat ${ownerFile} 2>/dev/null)" = ${token} ]`
  return [
    `: ${HOLDER_ARGV_TAG};`,
    // cwd pins this lock's inode, so a takeover that renames it cannot redirect the marker.
    `cd ${quotePosixShell(lockDir)} 2>/dev/null && ${ownsLock} || exit 0;`,
    'command -v flock >/dev/null 2>&1 || exit 0;',
    `{ command exec 9>>${holder}; } 2>/dev/null || exit 0;`,
    sharedLockLoop(9).replace('exit 75', 'exit 0'),
    // A filesystem that grants a second description an exclusive lock cannot prove anything.
    `if ( exec 8<${holder} && flock -x -n 8 ) 2>/dev/null; then exit 0; fi;`,
    `${ownsLock} || exit 0;`,
    `printf '%s' "$$" > ${quotePosixShell(`./${HOLDER_PID_FILENAME}`)} 2>/dev/null || exit 0;`,
    `echo ${INSTALL_LOCK_HOLDER_READY};`,
    `IFS= read -r holder_go && [ "$holder_go" = ${INSTALL_LOCK_HOLDER_MARK} ] && ${ownsLock} || exit 0;`,
    `printf ${HOLDER_MARKER} >&9 || exit 0;`,
    `echo ${INSTALL_LOCK_HOLDER_HELD};`,
    // This shell keeps fd 9 (the lock) and its tagged command line; stdin EOF means the desktop let go or died.
    'while IFS= read -r holder_rest; do :; done'
  ].join(' ')
}

/** Prefix for every command an owner with a live holder runs: a shared lock on the holder file
 * that lasts the whole command (children included), then proof the lock still names `owner`.
 * A contender's exclusive lock therefore succeeds only once the holder and every command are gone. */
export function installLockFenceStatement(lockDir: string, owner: InstallLockOwnerFile): string {
  return [
    // Grouped so the redirect failure is quiet without silencing the command's own stderr.
    `{ command exec 7<${quotePosixShell(holderPath(lockDir))}; } 2>/dev/null || exit ${INSTALL_LOCK_FENCE_EXIT_CODE};`,
    sharedLockLoop(7),
    `[ "$(cat ${quotePosixShell(ownerPath(lockDir, owner.fileName))} 2>/dev/null)" = ${quotePosixShell(owner.token)} ] || exit ${INSTALL_LOCK_FENCE_EXIT_CODE};`
  ].join(' ')
}

/** True (exit 0) when the lock at `lockPath` is marked flock-backed and nothing holds its file. */
function posixHolderGoneTest(lockPath: string, fd: number): string {
  const holder = quotePosixShell(holderPath(lockPath))
  return (
    `[ "$(head -c 16 ${holder} 2>/dev/null)" = ${HOLDER_MARKER} ] && ` +
    `( exec ${fd}<${holder} && flock -x -n ${fd} ) 2>/dev/null`
  )
}

/** Prints `HOLDER_EXITED <dirKey> <token>` only when one lock generation is flock-backed and
 * nothing holds it; unmarked, held, or flock-less locks print nothing. */
export function installLockHolderExitedProbeCommand(
  lockDir: string,
  ownerFileName: string
): string {
  const lock = quotePosixShell(lockDir)
  const owner = quotePosixShell(ownerPath(lockDir, ownerFileName))
  const identity = (variable: string): string =>
    `${variable}=$(stat -c %Y:%i ${lock} 2>/dev/null || stat -f %m:%i ${lock} 2>/dev/null)`
  return [
    `${identity('before_key')} || exit 0;`,
    `before_owner=$(head -c 128 ${owner} 2>/dev/null) || exit 0;`,
    `${posixHolderGoneTest(lockDir, 8)} || exit 0;`,
    `${identity('after_key')} || exit 0;`,
    `[ "$before_key" = "$after_key" ] && [ "$(head -c 128 ${owner} 2>/dev/null)" = "$before_owner" ] || exit 0;`,
    `echo "${HOLDER_EXITED} $before_key $before_owner"`
  ].join(' ')
}

/** Prints OWNED when the lock names `owner`, NOT_OWNED when it names no one or someone else. */
export function installLockOwnedByCommand(lockDir: string, owner: InstallLockOwnerFile): string {
  const ownerFile = quotePosixShell(ownerPath(lockDir, owner.fileName))
  return `if [ "$(cat ${ownerFile} 2>/dev/null)" = ${quotePosixShell(owner.token)} ]; then echo OWNED; else echo NOT_OWNED; fi`
}

const PROBE_LINE = /^HOLDER_EXITED (\d+:\d+) ([A-Za-z0-9-]{1,128})$/u

export function parseInstallLockHolderExit(output: string): InstallLockHolderExit | null {
  const match = PROBE_LINE.exec(output.trim().split(/\r?\n/u).at(-1) ?? '')
  return match ? { dirKey: match[1], token: match[2] } : null
}

/** Run after giving up on an unconfirmed holder: once it exits, clear any mark it left so the
 * lock keeps the age rules. A holder still running after the wait is killed first, so it can never
 * mark the lock later. */
export function installLockHolderUnmarkCommand(
  lockDir: string,
  owner: InstallLockOwnerFile
): string {
  const ownsLock = `[ "$(cat ${quotePosixShell(`./${owner.fileName}`)} 2>/dev/null)" = ${quotePosixShell(owner.token)} ]`
  const holder = quotePosixShell(`./${INSTALL_LOCK_HOLDER_FILENAME}`)
  return [
    `cd ${quotePosixShell(lockDir)} 2>/dev/null && ${ownsLock} || exit 0;`,
    'command -v flock >/dev/null 2>&1 || exit 0;',
    `{ command exec 9<${holder}; } 2>/dev/null || exit 0;`,
    'unmark_tries=0; until flock -x -n 9 2>/dev/null; do unmark_tries=$((unmark_tries + 1));',
    `if [ "$unmark_tries" -eq ${SHARED_LOCK_ATTEMPTS} ]; then holder_pid=$(head -c 16 ${quotePosixShell(`./${HOLDER_PID_FILENAME}`)} 2>/dev/null);`,
    `case "$holder_pid" in ''|*[!0-9]*) ;; *) if ${posixIsHolderProcess('holder_pid', owner.token)}; then kill -9 "$holder_pid" 2>/dev/null; fi;; esac; fi;`,
    // A killed holder can no longer write, so the mark is cleared even if the lock stays busy.
    `[ "$unmark_tries" -ge ${SHARED_LOCK_ATTEMPTS + 5} ] && break; sleep 1; done;`,
    `${ownsLock} && : > ${holder}`
  ].join(' ')
}

/** True only while `pidVariable` names this owner's holder: its command line carries the tag and
 * token. A reused pid or an unreadable /proc reads false, so nothing else is ever killed. */
function posixIsHolderProcess(pidVariable: string, token: string): string {
  // Split so this script's own command line never matches the tag.
  const [head, tail] = [HOLDER_ARGV_TAG.slice(0, 5), HOLDER_ARGV_TAG.slice(5)]
  const argv = `tr '\\000' '\\n' 2>/dev/null < "/proc/$${pidVariable}/cmdline"`
  return (
    `[ "$${pidVariable}" != "$$" ] && holder_argv=$(${argv}) && ` +
    `printf '%s\\n' "$holder_argv" | grep -qF "${head}""${tail}" && ` +
    `printf '%s\\n' "$holder_argv" | grep -qF -- ${quotePosixShell(token)}`
  )
}

/** Prefix for an owner's own lock removal: waits for its fenced commands to end, so a successor
 * never starts beside one. Still held after the bounded wait, it fails and leaves the lock, so the
 * owner keeps its token. A lock that already names another owner ends it at once. */
export function installLockReleaseGate(lockDir: string, owner: InstallLockOwnerFile): string {
  const ownerFile = quotePosixShell(ownerPath(lockDir, owner.fileName))
  return [
    `if gate_owner=$(cat ${ownerFile} 2>/dev/null) && [ "$gate_owner" != ${quotePosixShell(owner.token)} ]; then exit 0; fi;`,
    `if { command exec 7<${quotePosixShell(holderPath(lockDir))}; } 2>/dev/null && command -v flock >/dev/null 2>&1; then`,
    lockLoop(7, '-x', `{ echo ${INSTALL_LOCK_RELEASE_BUSY} >&2; exit 1; }`),
    'fi;'
  ].join(' ')
}

/** Pieces of the POSIX steal for a probed-gone holder; all empty without proof, so the steal
 * stays byte-identical to builds without flock-backed locks. */
export type HolderStealParts = {
  check: string
  gate: string
  claimCheck: string
  claim: string
  reason: string
}

export function posixHolderStealParts(
  lockDir: string,
  owner: InstallLockOwnerFile | undefined,
  exit: InstallLockHolderExit | undefined
): HolderStealParts {
  if (!owner || !exit) {
    return { check: '', gate: '', claimCheck: '', claim: '', reason: '' }
  }
  const holder = quotePosixShell(holderPath(lockDir))
  const ownedBy = `[ "$(cat ${quotePosixShell(ownerPath(lockDir, owner.fileName))} 2>/dev/null)" = ${quotePosixShell(exit.token)} ]`
  const sameGeneration = (key: string): string => `[ "$${key}" = ${quotePosixShell(exit.dirKey)} ]`
  return {
    // Cheap pre-mutex gate: the named generation still looks gone.
    check: `holder_exited=0; if ${sameGeneration('lock_key')} && ${ownedBy} && ${posixHolderGoneTest(lockDir, 8)}; then holder_exited=1; fi;`,
    gate: ' && [ "$holder_exited" != 1 ]',
    // Inside the steal mutex: fd 6's exclusive lock lasts to the end of the steal, so no fenced
    // command of the old owner can start while the lock is replaced.
    claimCheck: [
      'current_holder_exited=0;',
      `if ${sameGeneration('current_key')} && { command exec 6<${holder}; } 2>/dev/null; then`,
      `if flock -x -n 6 2>/dev/null && [ "$(head -c 16 ${holder} 2>/dev/null)" = ${HOLDER_MARKER} ] && ${ownedBy}; then current_holder_exited=1; fi;`,
      'fi;'
    ].join(' '),
    claim: ' || [ "$current_holder_exited" = 1 ]',
    reason: ' elif [ "$current_holder_exited" = 1 ]; then echo HOLDER_EXITED_OK;'
  }
}
