/**
 * The pre-activation copy of shared profile state that makes rollback sound.
 *
 * `docs/design/shipping-orcad.html` §04's state-schema row asks for "backward-readable
 * migrations or a pre-activation snapshot". Only the second is available here, and not as a
 * preference: Orca's persisted state carries **no schema version**. Migrations are cohort
 * and shape heuristics that run on load and rewrite in place, and the load path rebuilds
 * `settings` and `ui` from known fields — so a newer build's nested additions are silently
 * dropped by an older one rather than rejected. There is nothing to compare and nothing that
 * fails loudly, which rules out proving backward-readability and leaves the snapshot.
 *
 * What is snapshotted is deliberately narrow. `<root>/daemon` is EXCLUDED: it holds the live
 * daemon's socket, PID record and auth token, and that daemon outlives every orcad restart
 * by design. Restoring a stale copy of it over a running daemon would break the endpoint
 * fence that keeps its terminals adoptable — turning a rollback into the exact terminal
 * massacre the daemon exists to prevent.
 */
import { shellEscape } from './ssh-connection-utils'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { assertPosixOrcadHost as assertPosixHost } from './orcad-remote-host-support'

/**
 * Root-relative paths a rollback needs restored. Everything else under the data root is
 * either regenerable, or owned by a process that survives the rollback.
 */
export const ORCAD_SNAPSHOT_MEMBERS = [
  'orca-profile-index.json',
  // Pre-profiles layout; still read as a migration source.
  'orca-data.json',
  'profiles'
] as const

/** Never captured and never restored — see the module comment. */
export const ORCAD_SNAPSHOT_EXCLUDED = ['daemon', 'logs'] as const

/**
 * The member names go into the command unquoted (see `captureOrcadStateSnapshotCommand`), so
 * they must be inert. They are compile-time constants; this catches the edit that adds one
 * with a space or a metacharacter in it.
 */
function assertPlainMemberName(member: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(member)) {
    throw new Error(`Unsafe orcad snapshot member name: ${JSON.stringify(member)}`)
  }
  return member
}

export function orcadSnapshotDirName(fullVersion: string, takenAtMs: number): string {
  // Why the version and the timestamp: two activations of one version (a re-deploy after a
  // rejected activation) must not overwrite each other's snapshot.
  return `pre-${fullVersion}-${takenAtMs}`
}

/**
 * Capture the snapshot, or report why there is nothing to capture.
 *
 * Prints `CAPTURED`, or `EMPTY` when the data root holds none of the members — a first-ever
 * deployment, where there is no state to lose and therefore no snapshot to take. `EMPTY` is
 * reported rather than fabricating an empty archive, because a rollback that "restored" an
 * empty archive would wipe a root that had filled up in between.
 */
export function captureOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string
): string {
  assertPosixHost(host)
  const root = shellEscape(userDataDir)
  const dir = shellEscape(snapshotDir)
  const archive = shellEscape(joinRemotePath(host, snapshotDir, 'state.tar'))
  const memberTests = ORCAD_SNAPSHOT_MEMBERS.map(
    // Why the accumulated name is NOT quoted: `$members` is re-split by the shell before it
    // reaches tar, so a quoted name arrives as a literal `'profiles'` that tar cannot stat.
    // `assertPlainMemberName` is what makes leaving them bare safe.
    (member) =>
      `[ -e ${root}/${shellEscape(member)} ] && members="$members ${assertPlainMemberName(member)}";`
  ).join(' ')
  return [
    `members=;`,
    memberTests,
    'if [ -z "$members" ]; then echo EMPTY; else',
    `mkdir -p ${dir} && umask 077 &&`,
    // Why a temp name then mv: a deploy killed mid-tar must not leave a truncated archive
    // that a later rollback would happily restore.
    `tar -C ${root} -cf ${archive}.partial $members && mv ${archive}.partial ${archive} &&`,
    'echo CAPTURED; fi'
  ].join(' ')
}

export type OrcadSnapshotCapture = 'captured' | 'empty' | 'failed'

export function parseOrcadSnapshotCapture(output: string): OrcadSnapshotCapture {
  const value = output.trim().split('\n').pop()?.trim()
  if (value === 'CAPTURED') {
    return 'captured'
  }
  return value === 'EMPTY' ? 'empty' : 'failed'
}

export function probeOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  snapshotDir: string
): string {
  assertPosixHost(host)
  const archive = shellEscape(joinRemotePath(host, snapshotDir, 'state.tar'))
  return `test -f ${archive} && echo PRESENT || echo ABSENT`
}

/**
 * Restore the snapshot over the data root.
 *
 * Two things make this safe to run: the members are removed before extraction (so a file the
 * new version added is gone rather than half-shadowed), and neither the removal nor the
 * extraction can reach `<root>/daemon`, because the member list never names it.
 *
 * The caller must have stopped orcad first. This does not check — it cannot, from a shell —
 * so `orcad-remote-deploy.ts` owns that ordering.
 */
export function restoreOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string
): string {
  assertPosixHost(host)
  const root = shellEscape(userDataDir)
  const archive = shellEscape(joinRemotePath(host, snapshotDir, 'state.tar'))
  const removals = ORCAD_SNAPSHOT_MEMBERS.map(
    (member) => `rm -rf ${root}/${shellEscape(member)};`
  ).join(' ')
  return [
    `test -f ${archive} || { echo MISSING; exit 0; };`,
    `test -d ${root} || mkdir -p ${root};`,
    removals,
    `tar -C ${root} -xf ${archive} && echo RESTORED || echo FAILED`
  ].join(' ')
}

export type OrcadSnapshotRestore = 'restored' | 'missing' | 'failed'

export function parseOrcadSnapshotRestore(output: string): OrcadSnapshotRestore {
  const value = output.trim().split('\n').pop()?.trim()
  if (value === 'RESTORED') {
    return 'restored'
  }
  return value === 'MISSING' ? 'missing' : 'failed'
}

/**
 * Has the shared store been written since `activatedAt`?
 *
 * Prints the newest mtime (epoch seconds) across the snapshot members, or `UNKNOWN`. The
 * caller compares; an `UNKNOWN` becomes `null`, which `assessOrcadRollback` treats as "yes,
 * assume writes".
 */
export function newestStateMtimeCommand(host: RemoteHostPlatform, userDataDir: string): string {
  assertPosixHost(host)
  const root = shellEscape(userDataDir)
  const paths = ORCAD_SNAPSHOT_MEMBERS.map((member) => `${root}/${shellEscape(member)}`).join(' ')
  return [
    `newest=$(find ${paths} -type f -exec stat -c %Y {} + 2>/dev/null ||`,
    `find ${paths} -type f -exec stat -f %m {} + 2>/dev/null);`,
    'if [ -z "$newest" ]; then echo UNKNOWN; else',
    `echo "$newest" | sort -n | tail -1; fi`
  ].join(' ')
}

export function parseNewestStateMtimeSeconds(output: string): number | null {
  const value = output.trim().split('\n').pop()?.trim()
  if (!value || !/^\d+$/.test(value)) {
    return null
  }
  return Number.parseInt(value, 10)
}
