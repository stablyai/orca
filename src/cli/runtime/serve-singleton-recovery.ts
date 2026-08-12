import { lstat, readlink, rename, symlink, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { probeServeRuntimeHealth, type ServeRuntimeHealth } from './serve-runtime-health'

export const SINGLETON_ARTIFACT_NAMES = [
  'SingletonSocket',
  'SingletonCookie',
  'SingletonLock'
] as const

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
        | 'quarantine_failed'
    }

type ServeSingletonRecoveryOptions = {
  platform?: NodeJS.Platform
  localHostname?: string
  probeHealth?: (userDataPath: string) => Promise<ServeRuntimeHealth>
  isProcessAlive?: (pid: number) => boolean
  wait?: (delayMs: number) => Promise<void>
  quarantineSuffix?: string
}

type SingletonOwner = { hostname: string; pid: number }

export async function recoverStaleServeSingleton(
  userDataPath: string,
  options: ServeSingletonRecoveryOptions = {}
): Promise<ServeSingletonRecoveryResult> {
  if ((options.platform ?? process.platform) !== 'linux') {
    return { state: 'not-recoverable', reason: 'unsupported_platform' }
  }

  const probeHealth = options.probeHealth ?? probeServeRuntimeHealth
  const initialHealth = await probeHealth(userDataPath)
  if (initialHealth.healthy) {
    return { state: 'active-owner', runtimeId: initialHealth.runtimeId }
  }

  const localHostname = options.localHostname ?? hostname()
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
  const initialOwner = await readSingletonOwner(userDataPath)
  const initialAssessment = assessOwner(initialOwner, localHostname, isProcessAlive)
  if (initialAssessment) {
    return initialAssessment
  }

  await (options.wait ?? defaultWait)(OWNER_CONFIRMATION_DELAY_MS)
  const mutex = await acquireRecoveryMutex(userDataPath, isProcessAlive)
  if (!mutex) {
    return { state: 'not-recoverable', reason: 'recovery_in_progress' }
  }

  try {
    const confirmedHealth = await probeHealth(userDataPath)
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
    const quarantined = await quarantineSingletonArtifacts(userDataPath, suffix)
    if (!quarantined) {
      return { state: 'not-recoverable', reason: 'quarantine_failed' }
    }
    return { state: 'recovered', ownerPid: confirmedOwner.pid, quarantined }
  } finally {
    await mutex.release()
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
    return { hostname: '', pid: 0 }
  }
  const pid = Number(target.slice(separator + 1))
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { hostname: '', pid: 0 }
  }
  return { hostname: target.slice(0, separator), pid }
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

async function quarantineSingletonArtifacts(
  userDataPath: string,
  suffix: string
): Promise<string[] | null> {
  const moved: { source: string; target: string; name: string }[] = []
  try {
    for (const name of SINGLETON_ARTIFACT_NAMES) {
      const source = join(userDataPath, name)
      if (!(await exists(source))) {
        continue
      }
      const target = join(userDataPath, `${name}.${suffix}`)
      await rename(source, target)
      moved.push({ source, target, name })
    }
    return moved.map(({ name }) => `${name}.${suffix}`)
  } catch {
    for (const entry of moved.toReversed()) {
      await rename(entry.target, entry.source).catch(() => undefined)
    }
    return null
  }
}

async function acquireRecoveryMutex(
  userDataPath: string,
  isProcessAlive: (pid: number) => boolean
): Promise<{ release: () => Promise<void> } | null> {
  const path = join(userDataPath, RECOVERY_MUTEX_NAME)
  const owner = String(process.pid)
  let acquired = await createMutex(path, owner)
  if (!acquired) {
    const ownerPid = Number(await readlink(path).catch(() => ''))
    if (Number.isSafeInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
      await unlink(path).catch(() => undefined)
      acquired = await createMutex(path, owner)
    }
  }
  if (!acquired) {
    return null
  }
  return {
    release: async () => {
      const currentOwner = await readlink(path).catch(() => null)
      if (currentOwner === owner) {
        await unlink(path).catch(() => undefined)
      }
    }
  }
}

async function createMutex(path: string, owner: string): Promise<boolean> {
  try {
    await symlink(owner, path)
    return true
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  return await lstat(path).then(
    () => true,
    () => false
  )
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // Only ESRCH proves the recorded process is gone; every other error stays fail-closed.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function defaultWait(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs))
}
