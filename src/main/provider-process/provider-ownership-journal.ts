import { constants, accessSync, lstatSync, mkdirSync } from 'node:fs'
import { mkdir, lstat, open, opendir, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { profileStateAccessBootIdentity } from '../persistence/profile-state/access/profile-state-access-identity'
import { readPosixProcessRow, providerOwnerPidAbsent } from './provider-process-row-read'
import { proveProviderOwnershipBeforeLaunch } from './provider-ownership-launch-proof'
import {
  sweepOrphanedProviderGroup,
  providerGroupAbsent,
  providerOwnershipAbsent,
  retireProviderWatcher,
  type ProviderGroupIdentity
} from './provider-group-orphan-guard'
import { PROVIDER_GROUP_REAP_TIMEOUT_MS } from './provider-process-supervisor'
import { terminateProviderFaultDescendants } from './provider-fault-ownership'

const row = z.object({
  pid: z.number().int().min(2),
  ppid: z.number().int().min(0),
  pgid: z.number().int().min(1),
  startedAt: z.string().min(1).max(255),
  startResolution: z.enum(['clock-tick', 'microsecond', 'second'])
})
const recordSchema = z.object({
  version: z.literal(1),
  nonce: z.string().uuid(),
  hostname: z.string().max(255),
  statePath: z.string().max(4096),
  bootId: z.string().min(1).max(255),
  owner: row,
  leader: row,
  watcher: row,
  pgid: z.number().int().min(2)
})
const startups = new Map<string, Promise<void>>()
const MAX_RECORD_BYTES = 16_384
const availableDirectories = new Map<string, string | null>()

let installedDirectory: string | null = null

/** The terminal daemon owns its relayed agents, so it journals them beside its own runtime state. */
export function installProviderOwnershipDirectory(directory: string): void {
  installedDirectory = directory
}

export function providerOwnershipDirectory(): string {
  return installedDirectory ?? join(getAppEnvironment().getPath('userData'), 'provider-processes')
}

/** This synchronous launch seam checks host capability once, never once per chat. */
export function providerOwnershipBootId(): string | null {
  const directory = providerOwnershipDirectory()
  const previous = availableDirectories.get(directory)
  if (previous !== undefined) {
    return previous
  }
  let available: string | null = null
  try {
    const bootId = profileStateAccessBootIdentity()
    if (bootId && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(bootId)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      const info = lstatSync(directory)
      accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK)
      available =
        info.isDirectory() &&
        (info.mode & 0o077) === 0 &&
        (!process.getuid || info.uid === process.getuid())
          ? bootId
          : null
    }
  } catch {}
  availableDirectories.set(directory, available)
  return available
}

export async function waitForProviderGroupReap(
  pgid: number,
  timeoutMs = PROVIDER_GROUP_REAP_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) {
    return false
  }
  const deadline = performance.now() + timeoutMs
  while (!providerGroupAbsent(pgid)) {
    if (signal?.aborted || performance.now() >= deadline) {
      return false
    }
    try {
      await delay(25, undefined, { signal })
    } catch {
      return false
    }
  }
  return !signal?.aborted
}

export async function waitForProviderOwnershipReap(
  identity: ProviderGroupIdentity,
  timeoutMs = PROVIDER_GROUP_REAP_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<boolean> {
  const proof = new AbortController()
  const abort = (): void => proof.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    proof.abort()
  }
  const timer = setTimeout(() => proof.abort(), timeoutMs)
  const deadline = performance.now() + timeoutMs
  try {
    if (
      !(await waitForProviderGroupReap(identity.pgid, timeoutMs, proof.signal)) ||
      proof.signal.aborted
    ) {
      return false
    }
    if ((await retireProviderWatcher(identity, { signal: proof.signal })) === 'refused') {
      return false
    }
    return (
      !proof.signal.aborted &&
      (await waitForProviderGroupReap(
        identity.watcher.pgid,
        Math.max(0, deadline - performance.now()),
        proof.signal
      ))
    )
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

export function recoverProviderOwnership(directory: string, bootId: string): Promise<void> {
  const path = resolve(directory)
  let startup = startups.get(path)
  if (!startup) {
    startup = scanOwnership(path, bootId).catch((error) => {
      startups.delete(path)
      throw error
    })
    startups.set(path, startup)
  }
  return startup
}

async function scanOwnership(directory: string, bootId: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  ) {
    throw new Error('Provider ownership directory is not private')
  }
  const owners = new Map<string, ReturnType<typeof readPosixProcessRow>>()
  const localHostname = hostname()
  const dir = await opendir(directory)
  for await (const entry of dir) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }
    const path = join(directory, entry.name)
    const record = await readRecord(path)
    if (!record || record.statePath !== directory) {
      continue
    }
    if (record.bootId !== bootId) {
      if (record.hostname === localHostname) {
        await unlink(path).catch(() => {})
      }
      continue
    }
    if (
      record.leader.pid !== record.pgid ||
      record.leader.pgid !== record.pgid ||
      record.watcher.pgid !== record.watcher.pid
    ) {
      continue
    }
    const ownerKey = `${record.owner.pid}:${record.owner.startResolution}`
    let ownerRead = owners.get(ownerKey)
    if (!ownerRead) {
      ownerRead = readPosixProcessRow(record.owner.pid, record.owner.startResolution).then((row) =>
        row === null && !providerOwnerPidAbsent(record.owner.pid) ? 'unverifiable' : row
      )
      owners.set(ownerKey, ownerRead)
    }
    const owner = await ownerRead
    if (
      owner === 'unverifiable' ||
      (owner &&
        (record.owner.startResolution !== owner.startResolution ||
          record.owner.startedAt === owner.startedAt))
    ) {
      continue
    }
    const leader = await readPosixProcessRow(record.leader.pid, record.leader.startResolution)
    const originalLeaderGone =
      leader === null
        ? providerOwnerPidAbsent(record.leader.pid)
        : leader !== 'unverifiable' &&
          leader.startResolution === record.leader.startResolution &&
          leader.startedAt !== record.leader.startedAt
    // A gone anchor cannot recover detached ancestry; this is not a descendant-exit verdict.
    const descendants = originalLeaderGone
      ? undefined
      : await terminateProviderFaultDescendants(record)
    const swept = await sweepOrphanedProviderGroup(record)
    if (
      (swept === 'absent' || swept === 'killed') &&
      (await waitForProviderOwnershipReap(record)) &&
      (originalLeaderGone || descendants === 'exited')
    ) {
      await unlink(path).catch(() => {})
    }
  }
}

async function readRecord(path: string): Promise<z.infer<typeof recordSchema> | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.size > MAX_RECORD_BYTES ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      ) {
        return null
      }
      const buffer = Buffer.alloc(info.size + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > info.size) {
        return null
      }
      return recordSchema.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead)))
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export async function publishProviderOwnership(
  directory: string,
  bootId: string,
  leaderPid: number,
  watcherPid: number,
  parentPid = process.pid
) {
  await recoverProviderOwnership(directory, bootId)
  const { owner, leader, watcher } = await proveProviderOwnershipBeforeLaunch(
    leaderPid,
    watcherPid,
    parentPid
  )
  const identity: ProviderGroupIdentity = { leader, watcher, pgid: leaderPid }
  const nonce = randomUUID()
  const path = join(directory, `${nonce}.json`)
  const pending = `${path}.pending`
  const record = {
    version: 1,
    nonce,
    hostname: hostname(),
    statePath: resolve(directory),
    bootId,
    owner,
    ...identity
  }
  const file = await open(pending, 'wx', 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify(record))
    } finally {
      await file.close()
    }
    await rename(pending, path)
  } catch (error) {
    await unlink(pending).catch(() => {})
    throw error
  }
  return {
    identity,
    remove: async () => {
      if (providerOwnershipAbsent(identity)) {
        await unlink(path).catch(() => {})
      }
    },
    removeAfterNativeExit: () => unlink(path).catch(() => {})
  }
}
