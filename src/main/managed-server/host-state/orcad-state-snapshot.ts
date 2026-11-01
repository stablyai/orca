// Snapshots protect older builds from in-place state migrations; never restore live daemon sockets, PID records or auth tokens.
import {
  currentOrcadFence,
  ORCAD_FENCE_LOST_EXIT,
  ORCAD_FENCE_LOST_MARKER,
  posixOrcadFenceGuard,
  posixOrcadFenceOwnedTest,
  type OrcadFence
} from '../activation/orcad-activation-fence-scope'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import {
  isWindowsRemoteHost,
  joinRemotePath,
  type RemoteHostPlatform
} from '../../ssh/ssh-remote-platform'
import type { OrcadWindowsHostStateOp } from './orcad-windows-host-state-ops'
import { pruneOrcadSnapshotsScript } from './orcad-state-snapshot-space'
import {
  ORCAD_SNAPSHOT_FAILURE,
  ORCAD_SNAPSHOT_MEMBERS,
  ORCAD_STATE_MUTATION_BUSY,
  ORCAD_STATE_MUTATION_DEADLINE,
  ORCAD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS,
  ORCAD_STATE_MUTATION_LOCK_DIRNAME,
  ORCAD_STATE_RESTORE_STAGE_DIRNAME
} from './orcad-state-snapshot-members'
import { orcadWindowsHostOpCommand } from '../install/orcad-remote-windows-node'
import {
  posixStateMutationGroupRecord,
  posixStateMutationPidRecord
} from './orcad-state-mutation-owner-record'

/** Validate bare shell member words and send each path once to stay under gateway command limits (#30491). */
function plainMemberWords(): string {
  for (const member of ORCAD_SNAPSHOT_MEMBERS) {
    if (!/^[A-Za-z0-9._-]+$/.test(member)) {
      throw new Error(`Unsafe orcad snapshot member name: ${JSON.stringify(member)}`)
    }
  }
  return ORCAD_SNAPSHOT_MEMBERS.join(' ')
}

function windowsStateCommand(
  host: RemoteHostPlatform,
  baseDir: string,
  op: OrcadWindowsHostStateOp,
  args: string[]
): string | null {
  if (!isWindowsRemoteHost(host)) {
    return null
  }
  return orcadWindowsHostOpCommand(host, baseDir, op, args)
}

/** Host deadline; client observation lasts one minute longer. */
export const ORCAD_STATE_MUTATION_DEADLINE_SECONDS = 15 * 60

/** Host serialization and deadline survive SSH channel loss, preventing overlapping restores after client timeout. */
export function serializedStateMutationCommand(
  baseDir: string,
  script: string,
  heartbeatSeconds = ORCAD_STATE_MUTATION_FENCE_HEARTBEAT_SECONDS,
  // Calls outside a held activation fence must not refresh any fence.
  owned: OrcadFence | null = currentOrcadFence()
): string {
  const lock = quotePosixShell(`${baseDir}/${ORCAD_STATE_MUTATION_LOCK_DIRNAME}`)
  const busy = `echo ${ORCAD_STATE_MUTATION_BUSY}; exit 0;`
  const staleMinutes = Math.max(1, Math.ceil((3 * heartbeatSeconds) / 60))
  const guarded = [
    `lock=${lock};`,
    `mkdir -p ${quotePosixShell(baseDir)} 2>/dev/null;`,
    'if ! mkdir "$lock" 2>/dev/null; then',
    'holder=$(cat "$lock/pid" 2>/dev/null); group=$(cat "$lock/pgid" 2>/dev/null);',
    // Exclusive PID publication makes resumed contenders back off; no PID means work never started.
    'if [ -z "$holder" ]; then',
    `[ -n "$(find "$lock" -maxdepth 0 -mmin +1 2>/dev/null)" ] || { ${busy} };`,
    // A dead shell can leave tar/rm alive; any surviving process-group member still holds the lock.
    `elif [ -n "$group" ]; then kill -0 "-$group" 2>/dev/null && { ${busy} };`,
    // Without group proof, retain live PIDs or recent heartbeats.
    `elif kill -0 "$holder" 2>/dev/null || [ -z "$(find "$lock" -maxdepth 0 -mmin +${staleMinutes} 2>/dev/null)" ]; then ${busy}`,
    'fi;',
    `rm -rf "$lock"; mkdir "$lock" 2>/dev/null || { ${busy} }; fi;`,
    posixStateMutationPidRecord('"$lock"', busy),
    // Recheck after mutation-lock acquisition because fence takeover holds that lock too.
    owned
      ? `${posixOrcadFenceOwnedTest(owned)} || { rm -rf "$lock"; echo ${ORCAD_FENCE_LOST_MARKER}; exit ${ORCAD_FENCE_LOST_EXIT}; };`
      : '',
    posixStateMutationGroupRecord('"$lock"'),
    // Refresh only the owned fence with touch -c; never recreate a released fence or keep a successor fresh.
    `beat_fence() { touch -c -m "$lock" 2>/dev/null; ${
      owned
        ? `${posixOrcadFenceOwnedTest(owned)} && touch -c -m ${quotePosixShell(owned.lockDir)} 2>/dev/null;`
        : ':;'
    } };`,
    'beat_fence;',
    `( while sleep ${heartbeatSeconds} && kill -0 $$ 2>/dev/null; do beat_fence; done ) >/dev/null 2>&1 & beat=$!;`,
    // Reap quietly because gateways can merge job notices into verdict stdout.
    `trap 'kill "$beat" 2>/dev/null; wait "$beat" 2>/dev/null; rm -rf "$lock"' EXIT;`,
    script
  ].join(' ')
  const run = `sh -c ${quotePosixShell(guarded)}`
  return [
    // Superseded holders must refuse before acquiring the mutation lock.
    ...(owned ? [posixOrcadFenceGuard(owned)] : []),
    // Own the workload process group so teardown can account for every spawned mutation process.
    'orca_state_group() { if command -v setsid >/dev/null 2>&1; then ORCA_STATE_MUTATION_GROUP=1 setsid "$@";',
    `elif command -v perl >/dev/null 2>&1; then ORCA_STATE_MUTATION_GROUP=1 perl -e ${quotePosixShell('setpgrp(0, 0); exec { $ARGV[0] } @ARGV or exit 127')} "$@";`,
    'else "$@"; fi; };',
    // Run timeout inside the group so KILL reaches tar/rm; use word lists once and retain old BusyBox -t support.
    `orca_deadline=; if timeout 1 true 2>/dev/null; then orca_deadline="timeout -s KILL ${ORCAD_STATE_MUTATION_DEADLINE_SECONDS}";`,
    `elif timeout -t 1 true 2>/dev/null; then orca_deadline="timeout -t ${ORCAD_STATE_MUTATION_DEADLINE_SECONDS} -s KILL"; fi;`,
    `orca_state_group $orca_deadline ${run};`,
    `status=$?; ${owned ? `[ "$status" -eq ${ORCAD_FENCE_LOST_EXIT} ] && exit ${ORCAD_FENCE_LOST_EXIT}; ` : ''}if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then echo ${ORCAD_STATE_MUTATION_DEADLINE}; fi`
  ].join(' ')
}

export function orcadSnapshotDirName(fullVersion: string, takenAtMs: number): string {
  // Repeated attempts at the same version need distinct snapshots.
  return `pre-${fullVersion}-${takenAtMs}`
}

/** Preserve incumbent state so interrupted rollback can restore it. */
export function orcadRollbackRescueDirName(fullVersion: string, takenAtMs: number): string {
  return `rollback-rescue-${fullVersion}-${takenAtMs}`
}

/** Report EMPTY without fabricating a restorable archive; publish complete captures and remove failed partials before retry. */
export function captureOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string,
  baseDir: string,
  prune?: { snapshotsRoot: string; keep: readonly string[] }
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-capture', [userDataDir, snapshotDir])
  if (windows) {
    return windows
  }
  return serializedStateMutationCommand(
    baseDir,
    [
      `root=${quotePosixShell(userDataDir)}; dir=${quotePosixShell(snapshotDir)};`,
      `archive="$dir"/state.tar;`,
      `snapshot_fail() { printf '${ORCAD_SNAPSHOT_FAILURE} %s\\n' "$(printf %s "$1" | tr '\\n' ' ' | cut -c 1-400)"; echo FAILED; exit 0; };`,
      prune ? pruneOrcadSnapshotsScript(prune.snapshotsRoot, prune.keep) : '',
      // Members intentionally undergo shell word splitting into separate tar arguments.
      `members=; for m in ${plainMemberWords()}; do`,
      'if [ -e "$root/$m" ] || [ -L "$root/$m" ]; then',
      'links=$(find "$root/$m" -type l -print 2>&1) && [ -z "$links" ] ||',
      'snapshot_fail "$m holds a symbolic link or an entry Orca cannot read: $links";',
      'members="$members $m"; fi; done;',
      // Set umask before directory creation so the whole snapshot is owner-only.
      'if [ -z "$members" ]; then echo EMPTY; else umask 077;',
      // Publish only a completed tar; interrupted capture must never look restorable.
      'if err=$( { mkdir -p "$dir" && tar -C "$root" -cf "$archive.partial" $members &&',
      'mv "$archive.partial" "$archive"; } 2>&1 ); then echo CAPTURED; else',
      'rm -f "$archive.partial"; rmdir "$dir" 2>/dev/null; snapshot_fail "$err"; fi; fi'
    ].join(' ')
  )
}

type OrcadSnapshotCapture = 'captured' | 'empty' | 'failed'

/** Scan known verdict lines because gateways can append merged stderr after completion (#30491). */
function lastVerdict(output: string, verdicts: readonly string[]): string | undefined {
  return output
    .split('\n')
    .map((line) => line.trim())
    .findLast((line) => verdicts.includes(line))
}

export function parseOrcadSnapshotCapture(output: string): OrcadSnapshotCapture {
  const value = lastVerdict(output, ['CAPTURED', 'EMPTY', 'FAILED'])
  if (value === 'CAPTURED') {
    return 'captured'
  }
  return value === 'EMPTY' ? 'empty' : 'failed'
}

export function probeOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  snapshotDir: string,
  baseDir: string
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-probe', [snapshotDir])
  if (windows) {
    return windows
  }
  const archive = quotePosixShell(joinRemotePath(host, snapshotDir, 'state.tar'))
  return `test -f ${archive} && echo PRESENT || echo ABSENT`
}

type OrcadSnapshotPresence = 'present' | 'absent' | 'unverifiable'

/** Missing probe evidence is unverifiable rather than absent. */
export function parseOrcadSnapshotPresence(output: string): OrcadSnapshotPresence {
  const value = lastVerdict(output, ['PRESENT', 'ABSENT', 'UNKNOWN'])
  if (value === 'PRESENT') {
    return 'present'
  }
  return value === 'ABSENT' ? 'absent' : 'unverifiable'
}

/** Caller must stop orcad first; stage/extract before replacing only snapshot members, leaving daemon state untouched. */
export function restoreOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string,
  baseDir: string
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-restore', [userDataDir, snapshotDir])
  if (windows) {
    return windows
  }
  const members = plainMemberWords()
  return serializedStateMutationCommand(
    baseDir,
    [
      `root=${quotePosixShell(userDataDir)};`,
      `archive=${quotePosixShell(joinRemotePath(host, snapshotDir, 'state.tar'))};`,
      `stage="$root"/${ORCAD_STATE_RESTORE_STAGE_DIRNAME};`,
      'test -f "$archive" || { echo MISSING; exit 0; };',
      'umask 077;',
      'test -d "$root" || mkdir -p "$root";',
      // Re-extract intact archives so interrupted restoration can safely restart.
      'rm -rf "$stage"; mkdir -p "$stage" || { echo FAILED; exit 0; };',
      // Validate all archived bytes before deleting live state.
      'tar -C "$stage" -xf "$archive" 2>/dev/null || { rm -rf "$stage"; echo FAILED; exit 0; };',
      `ok=; for m in ${members}; do [ -e "$stage/$m" ] && ok=1; done;`,
      '[ -n "$ok" ] || { rm -rf "$stage"; echo FAILED; exit 0; };',
      removeMembersCommand(members),
      `[ -n "$ok" ] && for m in ${members}; do`,
      '[ ! -e "$stage/$m" ] || mv "$stage/$m" "$root/$m" || { ok=; break; }; done;',
      'if [ -n "$ok" ]; then rm -rf "$stage"; echo RESTORED; else echo FAILED; fi'
    ].join(' ')
  )
}

/** Clear candidate-written state when the original root was empty. */
export function clearOrcadStateSnapshotMembersCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  baseDir: string
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-clear', [userDataDir])
  if (windows) {
    return windows
  }
  return serializedStateMutationCommand(
    baseDir,
    [
      `root=${quotePosixShell(userDataDir)}; test -d "$root" || mkdir -p "$root"; ok=1;`,
      removeMembersCommand(plainMemberWords()),
      'if [ -n "$ok" ]; then echo RESTORED; else echo FAILED; fi'
    ].join(' ')
  )
}

function removeMembersCommand(members: string): string {
  return `[ -n "$ok" ] && for m in ${members}; do rm -rf "$root/$m" || { ok=; break; }; done;`
}

type OrcadSnapshotRestore = 'restored' | 'missing' | 'failed'

export function parseOrcadSnapshotRestore(output: string): OrcadSnapshotRestore {
  const value = lastVerdict(output, ['RESTORED', 'MISSING', 'FAILED'])
  if (value === 'RESTORED') {
    return 'restored'
  }
  return value === 'MISSING' ? 'missing' : 'failed'
}

/** Compare only after stopping the candidate; changed state cannot be handed to an older build. */
export function compareOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string,
  baseDir: string
): string {
  const windows = windowsStateCommand(host, baseDir, 'snapshot-compare', [userDataDir, snapshotDir])
  if (windows) {
    return windows
  }
  const unknown = '{ echo UNKNOWN; exit 0; };'
  return [
    `root=${quotePosixShell(userDataDir)}; dir=${quotePosixShell(snapshotDir)};`,
    `archive="$dir"/state.tar;`,
    `test -d "$root" && test -r "$root" && test -x "$root" || ${unknown}`,
    `test -f "$archive" || ${unknown}`,
    `comparison=$(mktemp -d "$dir"/compare.XXXXXX) || ${unknown}`,
    `trap 'rm -rf "$comparison"' EXIT HUP INT TERM;`,
    `tar -C "$comparison" -xf "$archive" || ${unknown}`,
    `links=$(find "$comparison" -type l -print) && [ -z "$links" ] || ${unknown}`,
    `verdict=UNCHANGED; for m in ${plainMemberWords()}; do`,
    'if [ -e "$root/$m" ] || [ -L "$root/$m" ]; then',
    `links=$(find "$root/$m" -type l -print) && [ -z "$links" ] || ${unknown}`,
    'diff -r "$root/$m" "$comparison/$m" >/dev/null 2>&1 || verdict=CHANGED;',
    'elif [ -e "$comparison/$m" ] || [ -L "$comparison/$m" ]; then verdict=CHANGED; fi; done;',
    'echo "$verdict"'
  ].join(' ')
}

export function orcadSnapshotIsUnchanged(output: string): boolean {
  return lastVerdict(output, ['UNCHANGED', 'CHANGED', 'UNKNOWN']) === 'UNCHANGED'
}
