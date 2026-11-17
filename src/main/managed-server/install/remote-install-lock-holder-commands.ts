import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import type { InstallLockOwnerFile } from './remote-install-lock-commands'

/** Inside the mkdir lock: shared-flocked by the owner's holder and every fenced command; its
 * content marks the lock flock-backed. Old builds never write it, so their locks keep today's rules. */
export const INSTALL_LOCK_HOLDER_FILENAME = '.holder-flock'
// Exclusively flocked by the holder alone, so a straggling fenced command never reads as a live holder.
const HOLDER_ALIVE_FILENAME = '.holder-alive'
const HOLDER_MARKER = 'held'
/** Exit status of a fenced command whose lock another owner now holds. */
export const INSTALL_LOCK_FENCE_EXIT_CODE = 75

export const INSTALL_LOCK_HOLDER_READY = 'HOLDER_READY'
export const INSTALL_LOCK_HOLDER_MARK = 'mark'
export const INSTALL_LOCK_HOLDER_HELD = 'HOLDER_HELD'
const HOLDER_EXITED = 'HOLDER_EXITED'
const HOLDER_LIVE = 'HOLDER_LIVE'
// Busybox flock has no -w, so shared waits poll; a contender's exclusive probe is momentary.
const SHARED_LOCK_ATTEMPTS = 10

/** Identifies one lock generation: the lock dir's mtime:inode plus the token its owner wrote. */
export type InstallLockHolderExit = { dirKey: string; token: string }

function holderPath(lockDir: string): string {
  return `${lockDir.replace(/\/+$/u, '')}/${INSTALL_LOCK_HOLDER_FILENAME}`
}

function alivePath(lockDir: string): string {
  return `${lockDir.replace(/\/+$/u, '')}/${HOLDER_ALIVE_FILENAME}`
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
  const alive = quotePosixShell(`./${HOLDER_ALIVE_FILENAME}`)
  const ownsLock = `[ "$(cat ${ownerFile} 2>/dev/null)" = ${token} ]`
  return [
    // cwd pins this lock's inode, so a takeover that renames it cannot redirect the marker.
    `cd ${quotePosixShell(lockDir)} 2>/dev/null && ${ownsLock} || exit 0;`,
    'command -v flock >/dev/null 2>&1 || exit 0;',
    `{ command exec 9>>${holder}; } 2>/dev/null || exit 0;`,
    sharedLockLoop(9).replace('exit 75', 'exit 0'),
    // A filesystem that grants a second description an exclusive lock cannot prove anything.
    `if ( exec 8<${holder} && flock -x -n 8 ) 2>/dev/null; then exit 0; fi;`,
    `{ command exec 5>>${alive}; } 2>/dev/null && flock -x -n 5 2>/dev/null || exit 0;`,
    `${ownsLock} || exit 0;`,
    `echo ${INSTALL_LOCK_HOLDER_READY};`,
    `IFS= read -r holder_go && [ "$holder_go" = ${INSTALL_LOCK_HOLDER_MARK} ] && ${ownsLock} || exit 0;`,
    `printf ${HOLDER_MARKER} >&9 || exit 0;`,
    `echo ${INSTALL_LOCK_HOLDER_HELD};`,
    // One process keeps fds 9 and 5 (the locks); stdin EOF means the desktop let go or died.
    'exec cat >/dev/null'
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

/** True (exit 0) when the lock at `lockPath` is marked flock-backed and its holder still runs. */
function posixHolderLiveTest(lockPath: string, fd: number): string {
  const holder = quotePosixShell(holderPath(lockPath))
  return (
    `[ "$(head -c 16 ${holder} 2>/dev/null)" = ${HOLDER_MARKER} ] && command -v flock >/dev/null 2>&1 && ` +
    `( exec ${fd}<${quotePosixShell(alivePath(lockPath))} || exit 1; flock -s -n ${fd} && exit 1; exit 0 ) 2>/dev/null`
  )
}

/** Prints `HOLDER_EXITED <dirKey> <token>` only when one lock generation is flock-backed and
 * nothing holds it, or `HOLDER_LIVE` while its holder runs; unmarked or flock-less locks print nothing. */
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
    `if ${posixHolderLiveTest(lockDir, 8)}; then echo ${HOLDER_LIVE}; exit 0; fi;`,
    `${posixHolderGoneTest(lockDir, 8)} || exit 0;`,
    `${identity('after_key')} || exit 0;`,
    `[ "$before_key" = "$after_key" ] && [ "$(head -c 128 ${owner} 2>/dev/null)" = "$before_owner" ] || exit 0;`,
    `echo "${HOLDER_EXITED} $before_key $before_owner"`
  ].join(' ')
}

const PROBE_LINE = /^HOLDER_EXITED (\d+:\d+) ([A-Za-z0-9-]{1,128})$/u

export function parseInstallLockHolderExit(output: string): InstallLockHolderExit | null {
  const match = PROBE_LINE.exec(output.trim().split(/\r?\n/u).at(-1) ?? '')
  return match ? { dirKey: match[1], token: match[2] } : null
}

export function isInstallLockHolderLive(output: string): boolean {
  return output.trim().split(/\r?\n/u).at(-1) === HOLDER_LIVE
}

/** Run after giving up on an unconfirmed holder: once it exits, clear any mark it left so the
 * lock keeps the age rules. Leaves a still-held file alone; the fence still covers this owner. */
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
    lockLoop(9, '-x', 'exit 0'),
    `${ownsLock} && : > ${holder}`
  ].join(' ')
}

/** Prefix for an owner's own lock removal: waits for its fenced commands to end, so a successor
 * never starts beside one. Still held after the bounded wait, the lock stays for a takeover. */
export function installLockReleaseGate(lockDir: string): string {
  return [
    `if { command exec 7<${quotePosixShell(holderPath(lockDir))}; } 2>/dev/null && command -v flock >/dev/null 2>&1; then`,
    lockLoop(7, '-x', 'exit 0'),
    'fi;'
  ].join(' ')
}

/** Pieces of the POSIX steal for flock-backed locks; all empty without a holder option, so the
 * steal stays byte-identical to builds without flock-backed locks. */
export type HolderStealParts = {
  check: string
  /** Appended to the fresh-age test: a live holder keeps the lock however old it is. */
  ageVeto: string
  gate: string
  claimCheck: string
  /** Appended to the stale-age test inside the steal mutex. */
  currentAgeVeto: string
  claim: string
  reason: string
}

export type InstallLockHolderStealOptions = {
  /** A flock-backed lock generation whose holder a probe found gone. */
  exited?: InstallLockHolderExit
  /** Never take a flock-backed lock by age while its holder still runs. */
  vetoLiveHolder?: boolean
}

export function posixHolderStealParts(
  lockDir: string,
  owner: InstallLockOwnerFile | undefined,
  options: InstallLockHolderStealOptions | undefined
): HolderStealParts {
  const veto = options?.vetoLiveHolder
    ? {
        check: `holder_live=0; if ${posixHolderLiveTest(lockDir, 4)}; then holder_live=1; fi;`,
        ageVeto: ' || [ "$holder_live" = 1 ]',
        claimCheck: `current_holder_live=0; if ${posixHolderLiveTest(lockDir, 4)}; then current_holder_live=1; fi;`,
        currentAgeVeto: ' && [ "$current_holder_live" != 1 ]'
      }
    : { check: '', ageVeto: '', claimCheck: '', currentAgeVeto: '' }
  const exit = options?.exited
  if (!owner || !exit) {
    return { ...veto, gate: '', claim: '', reason: '' }
  }
  const holder = quotePosixShell(holderPath(lockDir))
  const ownedBy = `[ "$(cat ${quotePosixShell(ownerPath(lockDir, owner.fileName))} 2>/dev/null)" = ${quotePosixShell(exit.token)} ]`
  const sameGeneration = (key: string): string => `[ "$${key}" = ${quotePosixShell(exit.dirKey)} ]`
  return {
    // Cheap pre-mutex gate: the named generation still looks gone.
    check: `${veto.check}holder_exited=0; if ${sameGeneration('lock_key')} && ${ownedBy} && ${posixHolderGoneTest(lockDir, 8)}; then holder_exited=1; fi;`,
    ageVeto: veto.ageVeto,
    gate: ' && [ "$holder_exited" != 1 ]',
    // Inside the steal mutex: fd 6's exclusive lock lasts to the end of the steal, so no fenced
    // command of the old owner can start while the lock is replaced.
    claimCheck: [
      `${veto.claimCheck}current_holder_exited=0;`,
      `if ${sameGeneration('current_key')} && { command exec 6<${holder}; } 2>/dev/null; then`,
      `if flock -x -n 6 2>/dev/null && [ "$(head -c 16 ${holder} 2>/dev/null)" = ${HOLDER_MARKER} ] && ${ownedBy}; then current_holder_exited=1; fi;`,
      'fi;'
    ].join(' '),
    currentAgeVeto: veto.currentAgeVeto,
    claim: ' || [ "$current_holder_exited" = 1 ]',
    reason: ' elif [ "$current_holder_exited" = 1 ]; then echo HOLDER_EXITED_OK;'
  }
}
