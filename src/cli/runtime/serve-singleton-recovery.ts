import { readlink, symlink, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { probeServeRuntimeHealth, type ServeRuntimeHealth } from './serve-runtime-health'
import { isServeProcessAlive } from './serve-process-liveness'
import { quarantineSingletonArtifacts } from './serve-singleton-quarantine'

export { SINGLETON_ARTIFACT_NAMES } from './serve-singleton-quarantine'

const RECOVERY_MUTEX_NAME = 'SingletonRecoveryLock'
const OWNER_CONFIRMATION_DELAY_MS = 300

export type ServeSingletonRecoveryResult =
  | { state: 'active-owner'; runtimeId: string }
  | { state: 'recovered'; ownerPid: number; quarantined: string[] }
  | {
      state: 'not-recoverable'
      reason:
        | 'unsupported_platform'
        | 'missing_lock'
        | 'invalid_lock'
        | 'remote_host_owner'
        | 'owner_process_alive'
        | 'owner_changed'
        | 'recovery_in_progress'
        | 'recovery_mutex_failed'
        | 'health_probe_failed'
        | 'quarantine_failed'
      errorCode?: string
    }

type ServeSingletonRecoveryOptions = {
  platform?: NodeJS.Platform
  localHostname?: string
  probeHealth?: (userDataPath: string) => Promise<ServeRuntimeHealth>
  isProcessAlive?: (pid: number) => boolean
  wait?: (delayMs: number) => Promise<void>
  quarantineSuffix?: string
  createMutexLink?: (target: string, path: string) => Promise<void>
  createRecoveryGuardLink?: (target: string, path: string) => Promise<void>
}

type SingletonOwner = { hostname: string; pid: number; lockTarget: string }

export async function recoverStaleServeSingleton(
  userDataPath: string,
  options: ServeSingletonRecoveryOptions = {}
): Promise<ServeSingletonRecoveryResult> {
  if ((options.platform ?? process.platform) !== 'linux') {
    return { state: 'not-recoverable', reason: 'unsupported_platform' }
  }

  const probeHealth = options.probeHealth ?? probeServeRuntimeHealth
  const initialHealth = await probeRecoveryHealth(probeHealth, userDataPath)
  if (!initialHealth) {
    return { state: 'not-recoverable', reason: 'health_probe_failed' }
  }
  if (initialHealth.healthy) {
    return { state: 'active-owner', runtimeId: initialHealth.runtimeId }
  }

  const localHostname = options.localHostname ?? hostname()
  const isProcessAlive = options.isProcessAlive ?? isServeProcessAlive
  const initialOwner = await readSingletonOwner(userDataPath)
  const initialAssessment = assessOwner(initialOwner, localHostname, isProcessAlive)
  if (initialAssessment) {
    return initialAssessment
  }

  await (options.wait ?? defaultWait)(OWNER_CONFIRMATION_DELAY_MS)
  const mutex = await acquireRecoveryMutex(
    userDataPath,
    isProcessAlive,
    options.createMutexLink ?? symlink
  )
  if (!mutex.acquired) {
    return {
      state: 'not-recoverable',
      reason: mutex.reason,
      ...(mutex.errorCode ? { errorCode: mutex.errorCode } : {})
    }
  }

  try {
    const confirmedHealth = await probeRecoveryHealth(probeHealth, userDataPath)
    if (!confirmedHealth) {
      return { state: 'not-recoverable', reason: 'health_probe_failed' }
    }
    if (confirmedHealth.healthy) {
      return { state: 'active-owner', runtimeId: confirmedHealth.runtimeId }
    }
    const confirmedOwner = await readSingletonOwner(userDataPath)
    if (
      !confirmedOwner ||
      confirmedOwner.hostname !== initialOwner!.hostname ||
      confirmedOwner.pid !== initialOwner!.pid
    ) {
      return { state: 'not-recoverable', reason: 'owner_changed' }
    }
    const confirmedAssessment = assessOwner(confirmedOwner, localHostname, isProcessAlive)
    if (confirmedAssessment) {
      return confirmedAssessment
    }

    const suffix = options.quarantineSuffix ?? `stale-${Date.now()}-${process.pid}`
    const quarantine = await quarantineSingletonArtifacts(
      userDataPath,
      suffix,
      confirmedOwner.lockTarget,
      `${localHostname}-${process.pid}`,
      () => !isProcessAlive(confirmedOwner.pid),
      options.createRecoveryGuardLink ?? symlink
    )
    if (quarantine.state === 'owner_changed') {
      return { state: 'not-recoverable', reason: 'owner_changed' }
    }
    if (quarantine.state === 'owner_process_alive') {
      return { state: 'not-recoverable', reason: 'owner_process_alive' }
    }
    if (quarantine.state === 'failed') {
      return {
        state: 'not-recoverable',
        reason: 'quarantine_failed',
        ...(quarantine.errorCode ? { errorCode: quarantine.errorCode } : {})
      }
    }
    return { state: 'recovered', ownerPid: confirmedOwner.pid, quarantined: quarantine.paths }
  } finally {
    await mutex.release()
  }
}

async function probeRecoveryHealth(
  probeHealth: (userDataPath: string) => Promise<ServeRuntimeHealth>,
  userDataPath: string
): Promise<ServeRuntimeHealth | null> {
  try {
    return await probeHealth(userDataPath)
  } catch {
    return null
  }
}

async function readSingletonOwner(userDataPath: string): Promise<SingletonOwner | null> {
  let target: string
  try {
    target = await readlink(join(userDataPath, 'SingletonLock'))
  } catch {
    return null
  }
  const separator = target.lastIndexOf('-')
  if (separator <= 0 || separator === target.length - 1) {
    return { hostname: '', pid: 0, lockTarget: target }
  }
  const pid = Number(target.slice(separator + 1))
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { hostname: '', pid: 0, lockTarget: target }
  }
  return { hostname: target.slice(0, separator), pid, lockTarget: target }
}

function assessOwner(
  owner: SingletonOwner | null,
  localHostname: string,
  isProcessAlive: (pid: number) => boolean
): ServeSingletonRecoveryResult | null {
  if (!owner) {
    return { state: 'not-recoverable', reason: 'missing_lock' }
  }
  if (!owner.hostname || owner.pid <= 0) {
    return { state: 'not-recoverable', reason: 'invalid_lock' }
  }
  if (owner.hostname !== localHostname) {
    return { state: 'not-recoverable', reason: 'remote_host_owner' }
  }
  if (isProcessAlive(owner.pid)) {
    return { state: 'not-recoverable', reason: 'owner_process_alive' }
  }
  return null
}

async function acquireRecoveryMutex(
  userDataPath: string,
  isProcessAlive: (pid: number) => boolean,
  createLink: (target: string, path: string) => Promise<void>
): Promise<
  | { acquired: true; release: () => Promise<void> }
  | {
      acquired: false
      reason: 'recovery_in_progress' | 'recovery_mutex_failed'
      errorCode?: string
    }
> {
  const path = join(userDataPath, RECOVERY_MUTEX_NAME)
  const owner = String(process.pid)
  let creation = await createMutex(path, owner, createLink)
  if (creation.state === 'failed') {
    return { acquired: false, reason: 'recovery_mutex_failed', errorCode: creation.errorCode }
  }
  if (creation.state === 'exists') {
    const ownerPid = Number(await readlink(path).catch(() => ''))
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
      await unlink(path).catch(() => undefined)
      creation = await createMutex(path, owner, createLink)
    }
  }
  if (creation.state === 'failed') {
    return { acquired: false, reason: 'recovery_mutex_failed', errorCode: creation.errorCode }
  }
  if (creation.state === 'exists') {
    return { acquired: false, reason: 'recovery_in_progress' }
  }
  return {
    acquired: true,
    release: async () => {
      const currentOwner = await readlink(path).catch(() => null)
      if (currentOwner === owner) {
        await unlink(path).catch(() => undefined)
      }
    }
  }
}

async function createMutex(
  path: string,
  owner: string,
  createLink: (target: string, path: string) => Promise<void>
): Promise<{ state: 'created' } | { state: 'exists' } | { state: 'failed'; errorCode?: string }> {
  try {
    await createLink(owner, path)
    return { state: 'created' }
  } catch (error) {
    const errorCode = (error as NodeJS.ErrnoException).code
    return errorCode === 'EEXIST'
      ? { state: 'exists' }
      : { state: 'failed', ...(errorCode ? { errorCode } : {}) }
  }
}

async function defaultWait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}
