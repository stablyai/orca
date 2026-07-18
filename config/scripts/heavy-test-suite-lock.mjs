import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HEAVY_SUITE_LOCK_BASENAME = 'stablyai-orca-heavy-suite-v2.lock'

const MALFORMED_LOCK_GRACE_MS = 30_000
const VALID_PHASES = new Set(['idle', 'spawning', 'running'])

export class HeavySuiteBusyError extends Error {
  constructor(message) {
    super(message)
    this.name = 'HeavySuiteBusyError'
  }
}

export function getHeavySuiteLockPath(tempDir = os.tmpdir()) {
  // POSIX temp directories are commonly shared by every account. Scope the
  // lock by uid there so one local user cannot block or recover another user's run.
  const userScope = typeof process.getuid === 'function' ? `-${process.getuid()}` : ''
  return path.join(tempDir, `${HEAVY_SUITE_LOCK_BASENAME}${userScope}`)
}

function isValidPid(pid) {
  return Number.isInteger(pid) && pid > 0
}

function parseOwner(rawOwner) {
  const owner = JSON.parse(rawOwner)
  const validChildState =
    (owner?.phase === 'running' && isValidPid(owner.childPid)) ||
    (owner?.phase !== 'running' && owner?.childPid === null)
  if (
    !owner ||
    typeof owner !== 'object' ||
    typeof owner.token !== 'string' ||
    !isValidPid(owner.ownerPid) ||
    !VALID_PHASES.has(owner.phase) ||
    !validChildState ||
    typeof owner.suite !== 'string' ||
    typeof owner.acquiredAt !== 'string' ||
    !Number.isFinite(Date.parse(owner.acquiredAt))
  ) {
    throw new Error('Invalid heavy-suite owner metadata')
  }
  return owner
}

function readOwner(lockPath) {
  const stats = lstatSync(lockPath)
  if (!stats.isFile()) {
    throw new Error('Heavy-suite lock is not a regular file')
  }
  return parseOwner(readFileSync(lockPath, 'utf8'))
}

function writeOwnerFile(filePath, owner) {
  writeFileSync(filePath, `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' })
}

export function isProcessAlive(pid, killProcess = process.kill) {
  if (!isValidPid(pid)) {
    return false
  }
  try {
    killProcess(pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    return code !== 'ESRCH'
  }
}

export function isProcessTreeAlive(
  pid,
  { platform = process.platform, killProcess = process.kill, spawnProcessSync = spawnSync } = {}
) {
  if (isProcessAlive(pid, killProcess)) {
    return true
  }
  if (!isValidPid(pid)) {
    return false
  }
  if (platform === 'win32') {
    const descendantProbe = [
      `$root = [uint32]${pid}`,
      '$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)',
      '$frontier = @($root)',
      '$seen = @{}',
      '$found = $false',
      'while ($frontier.Count -gt 0) {',
      '  $children = @($processes | Where-Object { $frontier -contains [uint32]$_.ParentProcessId -and -not $seen.ContainsKey([uint32]$_.ProcessId) })',
      '  if ($children.Count -eq 0) { break }',
      '  $found = $true',
      '  foreach ($child in $children) { $seen[[uint32]$child.ProcessId] = $true }',
      '  $frontier = @($children | ForEach-Object { [uint32]$_.ProcessId })',
      '}',
      "if ($found) { Write-Output 'ORCA_DESCENDANT_ALIVE' } else { Write-Output 'ORCA_NO_DESCENDANT' }"
    ].join('\n')
    const result = spawnProcessSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', descendantProbe],
      {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 5_000
      }
    )
    if (result?.status === 0 && String(result.stdout).trim() === 'ORCA_NO_DESCENDANT') {
      return false
    }
    // Unknown probe results fail closed: preserving a stale lock is safer than
    // admitting a second Electron tree while the first may still be alive.
    return true
  }
  try {
    killProcess(-pid, 0)
    return true
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    return code !== 'ESRCH'
  }
}

function publishOwner(lockPath, owner) {
  const candidatePath = `${lockPath}.candidate-${process.pid}-${owner.token}`
  try {
    writeOwnerFile(candidatePath, owner)
    try {
      // Hard-link publication is atomic no-replace. Unlike rename, it cannot
      // replace even an empty or malformed existing lock.
      linkSync(candidatePath, lockPath)
      return true
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null
      if (code === 'EEXIST') {
        return false
      }
      throw error
    }
  } finally {
    rmSync(candidatePath, { force: true })
  }
}

function writeOwnerAtomically(lockPath, owner) {
  const temporaryPath = `${lockPath}.update-${process.pid}-${owner.token}-${randomUUID()}`
  try {
    writeOwnerFile(temporaryPath, owner)
    renameSync(temporaryPath, lockPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function readLockObservation(lockPath, now) {
  let stats
  try {
    stats = lstatSync(lockPath)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'ENOENT') {
      return { kind: 'missing' }
    }
    throw error
  }

  const malformedObservation = {
    kind: 'malformed',
    ageMs: Math.max(0, now() - stats.mtimeMs),
    regularFile: stats.isFile(),
    fingerprint: {
      dev: String(stats.dev),
      ino: String(stats.ino),
      mode: stats.mode,
      size: stats.size,
      mtimeMs: stats.mtimeMs
    }
  }
  if (!stats.isFile()) {
    return malformedObservation
  }
  try {
    return { kind: 'owner', owner: parseOwner(readFileSync(lockPath, 'utf8')) }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    return code === 'ENOENT' ? { kind: 'missing' } : malformedObservation
  }
}

function observationsMatch(observed, current) {
  if (observed.kind !== current.kind) {
    return false
  }
  if (observed.kind === 'owner') {
    return observed.owner.token === current.owner.token
  }
  if (observed.kind === 'malformed') {
    return JSON.stringify(observed.fingerprint) === JSON.stringify(current.fingerprint)
  }
  return true
}

function busyMessage(requestedSuite, activeSuite, ownerPid) {
  return `[heavy-suite] Cannot start ${requestedSuite}: ${activeSuite} is already running (owner pid ${ownerPid}). Wait for it to finish or stop that exact run.`
}

function assertRecoverableObservation(
  observation,
  { suite, lockPath, isOwnerAlive, isChildTreeAlive }
) {
  const lockName = path.basename(lockPath)
  if (observation.kind === 'missing') {
    return false
  }
  if (observation.kind === 'malformed') {
    if (!observation.regularFile) {
      throw new HeavySuiteBusyError(
        `[heavy-suite] Cannot start ${suite}: the shared lock is not a regular file. Inspect ${lockName} without deleting it recursively.`
      )
    }
    if (observation.ageMs < MALFORMED_LOCK_GRACE_MS) {
      throw new HeavySuiteBusyError(
        `[heavy-suite] Cannot start ${suite}: the shared lock is initializing or malformed; retry after 30 seconds.`
      )
    }
    return true
  }

  const currentOwner = observation.owner
  const ownerActive = isOwnerAlive(currentOwner.ownerPid)
  const childActive = currentOwner.phase === 'running' && isChildTreeAlive(currentOwner.childPid)
  if (ownerActive || childActive) {
    throw new HeavySuiteBusyError(busyMessage(suite, currentOwner.suite, currentOwner.ownerPid))
  }
  if (currentOwner.phase === 'spawning') {
    throw new HeavySuiteBusyError(
      `[heavy-suite] Cannot start ${suite}: ${currentOwner.suite} stopped while starting a child process. Verify that exact run before removing ${lockName}.`
    )
  }
  return true
}

export function getHeavySuiteRecoveryGuardPath(lockPath) {
  return `${lockPath}.recovery`
}

function acquireRecoveryGuard(lockPath, suite, now, isOwnerAlive) {
  const guardPath = getHeavySuiteRecoveryGuardPath(lockPath)
  const token = randomUUID()
  const owner = {
    token,
    ownerPid: process.pid,
    childPid: null,
    phase: 'idle',
    suite: `recovery:${suite}`,
    acquiredAt: new Date(now()).toISOString()
  }
  if (publishOwner(guardPath, owner)) {
    return { lockPath: guardPath, token, owner }
  }

  let currentGuard
  try {
    currentGuard = readOwner(guardPath)
  } catch {
    if (!existsSync(guardPath)) {
      return null
    }
    throw new HeavySuiteBusyError(
      `[heavy-suite] Cannot recover ${suite}: the recovery guard is malformed. Verify no recovery is active before removing it.`
    )
  }
  if (isOwnerAlive(currentGuard.ownerPid)) {
    throw new HeavySuiteBusyError(
      `[heavy-suite] Cannot recover ${suite}: another session is already recovering the shared lock.`
    )
  }
  throw new HeavySuiteBusyError(
    `[heavy-suite] Cannot recover ${suite}: a previous recovery stopped unexpectedly. Verify that run before removing the recovery guard.`
  )
}

function recoverObservedStaleLock({
  lockPath,
  observed,
  suite,
  now,
  isOwnerAlive,
  isChildTreeAlive
}) {
  const guard = acquireRecoveryGuard(lockPath, suite, now, isOwnerAlive)
  if (!guard) {
    return false
  }

  let recovered = false
  let recoveryError = null
  try {
    const current = readLockObservation(lockPath, now)
    if (
      observationsMatch(observed, current) &&
      assertRecoverableObservation(current, { suite, lockPath, isOwnerAlive, isChildTreeAlive })
    ) {
      const tombstonePath = `${lockPath}.stale-${process.pid}-${guard.token}-${randomUUID()}`
      try {
        renameSync(lockPath, tombstonePath)
        rmSync(tombstonePath, { force: true })
        recovered = true
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? error.code : null
        if (code !== 'ENOENT') {
          throw error
        }
      }
    }
  } catch (error) {
    recoveryError = error
  }

  if (!releaseHeavySuiteLock(guard)) {
    throw new Error('[heavy-suite] Refused to release the stale-lock recovery guard')
  }
  if (recoveryError) {
    throw recoveryError
  }
  return recovered
}

export function acquireHeavySuiteLock({
  suite,
  tempDir = os.tmpdir(),
  ownerPid = process.pid,
  now = Date.now,
  isOwnerAlive = isProcessAlive,
  isChildTreeAlive = (pid) => isProcessTreeAlive(pid),
  afterPublishConflict = () => {},
  beforeStaleRecovery = () => {}
}) {
  const lockPath = getHeavySuiteLockPath(tempDir)
  const token = randomUUID()
  const owner = {
    token,
    ownerPid,
    childPid: null,
    phase: 'idle',
    suite,
    acquiredAt: new Date(now()).toISOString()
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (publishOwner(lockPath, owner)) {
      return { lockPath, token, owner }
    }

    afterPublishConflict({ lockPath, attempt })
    const observed = readLockObservation(lockPath, now)
    if (observed.kind === 'missing') {
      continue
    }
    assertRecoverableObservation(observed, { suite, lockPath, isOwnerAlive, isChildTreeAlive })
    beforeStaleRecovery({ lockPath, observed })
    recoverObservedStaleLock({
      lockPath,
      observed,
      suite,
      now,
      isOwnerAlive,
      isChildTreeAlive
    })
  }

  throw new Error(`[heavy-suite] Could not acquire the shared lock for ${suite}`)
}

export function updateHeavySuiteState(handle, { phase, childPid }) {
  const currentOwner = readOwner(handle.lockPath)
  if (currentOwner.token !== handle.token) {
    throw new Error('[heavy-suite] Lock ownership changed before metadata update')
  }
  const nextOwner = parseOwner(JSON.stringify({ ...currentOwner, phase, childPid }))
  writeOwnerAtomically(handle.lockPath, nextOwner)
  handle.owner = nextOwner
  return handle
}

export function releaseHeavySuiteLock(
  handle,
  { renameLock = renameSync, removeReleased = rmSync } = {}
) {
  let currentOwner
  try {
    currentOwner = readOwner(handle.lockPath)
  } catch {
    return false
  }
  if (currentOwner.token !== handle.token) {
    return false
  }

  const releasedPath = `${handle.lockPath}.released-${process.pid}-${handle.token}-${randomUUID()}`
  try {
    renameLock(handle.lockPath, releasedPath)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null
    if (code === 'ENOENT') {
      return false
    }
    throw error
  }
  removeReleased(releasedPath, { force: true })
  return true
}
