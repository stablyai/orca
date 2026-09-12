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
import { isWindowsRemoteHost, joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import { assertPosixOrcadHost as assertPosixHost } from './orcad-remote-host-support'
import { powerShellCommand, powerShellLiteral } from './ssh-remote-powershell'

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
export const ORCAD_SNAPSHOT_EXCLUDED = ['daemon', 'logs', 'orcad.lock'] as const

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

export function orcadRollbackRescueDirName(fullVersion: string, takenAtMs: number): string {
  return `rollback-rescue-${fullVersion}-${takenAtMs}`
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
  if (isWindowsRemoteHost(host)) {
    return windowsCaptureOrcadStateSnapshotCommand(host, userDataDir, snapshotDir)
  }
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
    `umask 077; members=;`,
    memberTests,
    'if [ -z "$members" ]; then echo EMPTY; else',
    `mkdir -p ${dir} &&`,
    // Why a temp name then mv: a deploy killed mid-tar must not leave a truncated archive
    // that a later rollback would happily restore.
    `tar -C ${root} -cf ${archive}.partial $members && mv ${archive}.partial ${archive} &&`,
    'echo CAPTURED; fi'
  ].join(' ')
}

function windowsCaptureOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string
): string {
  const archive = joinRemotePath(host, snapshotDir, 'state.tar')
  const members = ORCAD_SNAPSHOT_MEMBERS.map(powerShellLiteral).join(', ')
  return powerShellCommand(
    [
      `$root = ${powerShellLiteral(userDataDir)}`,
      `$snapshotDir = ${powerShellLiteral(snapshotDir)}`,
      `$archive = ${powerShellLiteral(archive)}`,
      `$members = @(${members}) | Where-Object { Test-Path -LiteralPath (Join-Path $root $_) }`,
      `if (@($members).Count -eq 0) { Write-Output 'EMPTY'; exit 0 }`,
      `New-Item -ItemType Directory -Path $snapshotDir -Force -ErrorAction Stop | Out-Null`,
      `$partial = $archive + '.partial'`,
      `Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue`,
      `& tar.exe -C $root -cf $partial @members`,
      `if ($LASTEXITCODE -ne 0) { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue; Write-Output 'FAILED'; exit 0 }`,
      `Move-Item -LiteralPath $partial -Destination $archive -Force -ErrorAction Stop`,
      `Write-Output 'CAPTURED'`
    ].join('; ')
  )
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
  if (isWindowsRemoteHost(host)) {
    const archive = joinRemotePath(host, snapshotDir, 'state.tar')
    return powerShellCommand(
      `if (Test-Path -LiteralPath ${powerShellLiteral(archive)} -PathType Leaf) { ` +
        `Write-Output 'PRESENT' } else { Write-Output 'ABSENT' }`
    )
  }
  assertPosixHost(host)
  const archive = shellEscape(joinRemotePath(host, snapshotDir, 'state.tar'))
  return `test -f ${archive} && echo PRESENT || echo ABSENT`
}

export type OrcadSnapshotPresence = 'present' | 'absent' | 'unverifiable'

export function parseOrcadSnapshotPresence(output: string): OrcadSnapshotPresence {
  const value = output.trim().split('\n').pop()?.trim()
  if (value === 'PRESENT') {
    return 'present'
  }
  return value === 'ABSENT' ? 'absent' : 'unverifiable'
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
  if (isWindowsRemoteHost(host)) {
    return windowsRestoreOrcadStateSnapshotCommand(host, userDataDir, snapshotDir)
  }
  assertPosixHost(host)
  const root = shellEscape(userDataDir)
  const archive = shellEscape(joinRemotePath(host, snapshotDir, 'state.tar'))
  const stage = shellEscape(joinRemotePath(host, userDataDir, '.orcad-state-restore-stage'))
  const removals = ORCAD_SNAPSHOT_MEMBERS.map(
    (member) => `rm -rf ${root}/${shellEscape(member)}`
  ).join(' && ')
  const replacements = ORCAD_SNAPSHOT_MEMBERS.map(
    (member) =>
      `if [ -e ${stage}/${shellEscape(member)} ]; then mv ${stage}/${shellEscape(member)} ${root}/${shellEscape(member)}; fi`
  ).join(' && ')
  const stagedMemberChecks = ORCAD_SNAPSHOT_MEMBERS.map(
    (member) => `[ -e ${stage}/${shellEscape(member)} ]`
  ).join(' || ')
  return [
    `test -f ${archive} || { echo MISSING; exit 0; };`,
    `umask 077;`,
    `test -d ${root} || mkdir -p ${root};`,
    `rm -rf ${stage}; mkdir -p ${stage} || { echo FAILED; exit 0; };`,
    // Extraction proves every archived byte is readable before live state is removed.
    `tar -C ${stage} -xf ${archive} 2>/dev/null || { rm -rf ${stage}; echo FAILED; exit 0; };`,
    `${stagedMemberChecks} || { rm -rf ${stage}; echo FAILED; exit 0; };`,
    `if ${removals} && ${replacements}; then rm -rf ${stage}; echo RESTORED; else echo FAILED; fi`
  ].join(' ')
}

function windowsRestoreOrcadStateSnapshotCommand(
  host: RemoteHostPlatform,
  userDataDir: string,
  snapshotDir: string
): string {
  const archive = joinRemotePath(host, snapshotDir, 'state.tar')
  const stage = joinRemotePath(host, userDataDir, '.orcad-state-restore-stage')
  const members = ORCAD_SNAPSHOT_MEMBERS.map(powerShellLiteral).join(', ')
  return powerShellCommand(
    [
      `$root = ${powerShellLiteral(userDataDir)}`,
      `$archive = ${powerShellLiteral(archive)}`,
      `$stage = ${powerShellLiteral(stage)}`,
      `if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { Write-Output 'MISSING'; exit 0 }`,
      `try { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop }`,
      `New-Item -ItemType Directory -Path $stage -Force -ErrorAction Stop | Out-Null`,
      `& tar.exe -C $stage -xf $archive`,
      `if ($LASTEXITCODE -ne 0) { throw 'tar validation extraction failed' }`,
      `$stagedMembers = @(@(${members}) | Where-Object { Test-Path -LiteralPath (Join-Path $stage $_) })`,
      `if ($stagedMembers.Count -eq 0) { throw 'snapshot contained no managed state members' }`,
      `New-Item -ItemType Directory -Path $root -Force -ErrorAction Stop | Out-Null`,
      `@(${members}) | ForEach-Object { $path = Join-Path $root $_; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop } }`,
      `@(${members}) | ForEach-Object { $source = Join-Path $stage $_; if (Test-Path -LiteralPath $source) { Move-Item -LiteralPath $source -Destination (Join-Path $root $_) -Force -ErrorAction Stop } }`,
      `Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop`,
      `Write-Output 'RESTORED' } catch { Write-Output 'FAILED' }`
    ].join('; ')
  )
}

/** Restore an originally empty state root after a rejected candidate populated it. */
export function clearOrcadStateSnapshotMembersCommand(
  host: RemoteHostPlatform,
  userDataDir: string
): string {
  if (isWindowsRemoteHost(host)) {
    const members = ORCAD_SNAPSHOT_MEMBERS.map(powerShellLiteral).join(', ')
    return powerShellCommand(
      [
        `$root = ${powerShellLiteral(userDataDir)}`,
        `try { New-Item -ItemType Directory -Path $root -Force -ErrorAction Stop | Out-Null`,
        `@(${members}) | ForEach-Object { $path = Join-Path $root $_; if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop } }`,
        `Write-Output 'RESTORED' } catch { Write-Output 'FAILED' }`
      ].join('; ')
    )
  }
  assertPosixHost(host)
  const root = shellEscape(userDataDir)
  const removals = ORCAD_SNAPSHOT_MEMBERS.map(
    (member) => `rm -rf ${root}/${shellEscape(member)}`
  ).join(' && ')
  return [
    `umask 077;`,
    `test -d ${root} || mkdir -p ${root};`,
    `if ${removals}; then echo RESTORED; else echo FAILED; fi`
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
  if (isWindowsRemoteHost(host)) {
    const members = ORCAD_SNAPSHOT_MEMBERS.map(powerShellLiteral).join(', ')
    return powerShellCommand(
      [
        `$root = ${powerShellLiteral(userDataDir)}`,
        `$files = @(@(${members}) | ForEach-Object { ` +
          `$path = Join-Path $root $_; if (Test-Path -LiteralPath $path) { ` +
          `Get-ChildItem -LiteralPath $path -File -Recurse -Force -ErrorAction SilentlyContinue } })`,
        `if ($files.Count -eq 0) { Write-Output 'UNKNOWN'; exit 0 }`,
        `$newest = $files | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1`,
        `Write-Output (([DateTimeOffset]$newest.LastWriteTimeUtc).ToUnixTimeSeconds())`
      ].join('; ')
    )
  }
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
