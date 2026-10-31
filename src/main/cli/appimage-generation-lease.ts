// Process identities in <cache>/leases survive payload deletion; pre-lease builds ignore them.
import { randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { ProcessLivenessVerdict } from '../daemon/daemon-incarnation-evidence-types'
import { parseLinuxStartTicks, readBootIdentity } from '../agent-hooks/managed-hook-owner-identity'
import {
  resolveAppImageGenerationOfExecutable,
  type AppImageGenerationLocation
} from '../../shared/appimage-cache-identity'
import { isAppImageCacheKey } from './appimage-cache-layout'

const LEASE_DIRECTORY_NAME = 'leases'
const LEASE_SUFFIX = '.json'
// A lease is written by temp-and-rename, so an unreadable one is foreign or damaged, not torn.
const UNREADABLE_LEASE_GRACE_MS = 60_000

export {
  resolveAppImageGenerationOfExecutable,
  type AppImageGenerationLocation
} from '../../shared/appimage-cache-identity'

type LeaseRecord = { pid: number; linuxStartTicks: string; bootId: string }

export type ProcessStartTicksRead =
  | { status: 'present'; startTicks: string }
  | { status: 'missing' }
  | { status: 'unavailable' }

export type AppImageLeaseProcessReader = {
  readStartTicks(pid: number): ProcessStartTicksRead
  readBootId(): Promise<string | undefined>
}

export function resolveAppImageGenerationOfRoot(
  cacheRootPath: string,
  rootPath: string
): AppImageGenerationLocation | null {
  const resolvedRoot = resolve(rootPath)
  const namespacePath = dirname(resolvedRoot)
  const location = {
    cacheRootPath: resolve(cacheRootPath),
    namespaceKey: basename(namespacePath),
    generationKey: basename(resolvedRoot),
    rootPath: resolvedRoot
  }
  return dirname(namespacePath) === location.cacheRootPath &&
    isAppImageCacheKey(location.namespaceKey) &&
    isAppImageCacheKey(location.generationKey)
    ? location
    : null
}

function leaseDirectory(cacheRootPath: string): string {
  return join(resolve(cacheRootPath), LEASE_DIRECTORY_NAME)
}

function leasePrefix(location: AppImageGenerationLocation): string {
  return `${location.namespaceKey}.${location.generationKey}.`
}

/** Records a lease for this process when it runs from an extracted generation; Linux only. */
export async function leaseAppImageGenerationForCurrentProcess(
  options: {
    execPath?: string
    pid?: number
    platform?: NodeJS.Platform
    reader?: AppImageLeaseProcessReader
  } = {}
): Promise<string | null> {
  if ((options.platform ?? process.platform) !== 'linux') {
    return null
  }
  const location = resolveAppImageGenerationOfExecutable(options.execPath ?? process.execPath)
  if (!location) {
    return null
  }
  const pid = options.pid ?? process.pid
  const reader = options.reader ?? linuxLeaseProcessReader
  const startTicks = reader.readStartTicks(pid)
  const bootId = await reader.readBootId()
  if (startTicks.status !== 'present' || !bootId) {
    console.warn('[appimage] could not record a generation lease: process identity unavailable')
    return null
  }
  const record: LeaseRecord = { pid, linuxStartTicks: startTicks.startTicks, bootId }
  const directory = leaseDirectory(location.cacheRootPath)
  const leasePath = join(
    directory,
    `${leasePrefix(location)}${pid}.${startTicks.startTicks}${LEASE_SUFFIX}`
  )
  const temporaryPath = join(directory, `.lease-${pid}-${randomUUID()}`)
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(temporaryPath, JSON.stringify(record), { mode: 0o600 })
    await rename(temporaryPath, leasePath)
  } catch (error) {
    await unlink(temporaryPath).catch(() => {})
    console.warn(
      '[appimage] could not record a generation lease:',
      error instanceof Error ? error.message : error
    )
    return null
  }
  if (pid === process.pid) {
    process.once('exit', () => {
      try {
        unlinkSync(leasePath)
      } catch {}
    })
  }
  return leasePath
}

/** Whether any lease on `rootPath` names a live process; stale leases are reclaimed. */
export async function inspectAppImageGenerationLeases(
  cacheRootPath: string,
  rootPath: string,
  reader: AppImageLeaseProcessReader = linuxLeaseProcessReader
): Promise<ProcessLivenessVerdict> {
  const location = resolveAppImageGenerationOfRoot(cacheRootPath, rootPath)
  if (!location) {
    return { status: 'exited' }
  }
  const directory = leaseDirectory(cacheRootPath)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
      ? { status: 'exited' }
      : { status: 'unverifiable', reason: 'lease directory unreadable' }
  }
  const prefix = leasePrefix(location)
  let bootId: string | undefined
  let verdict: ProcessLivenessVerdict = { status: 'exited' }
  for (const name of names.filter((n) => n.startsWith(prefix) && n.endsWith(LEASE_SUFFIX))) {
    const leasePath = join(directory, name)
    const record = await readLeaseRecord(leasePath)
    if (record === 'unreadable') {
      if (await isOlderThan(leasePath, UNREADABLE_LEASE_GRACE_MS)) {
        await unlink(leasePath).catch(() => {})
        continue
      }
      verdict = { status: 'unverifiable', reason: `lease ${name} unreadable` }
      continue
    }
    bootId ??= await reader.readBootId()
    const startTicks = reader.readStartTicks(record.pid)
    if (!bootId || startTicks.status === 'unavailable') {
      verdict = { status: 'unverifiable', reason: `lease holder ${record.pid} unverifiable` }
      continue
    }
    if (
      record.bootId === bootId &&
      startTicks.status === 'present' &&
      startTicks.startTicks === record.linuxStartTicks
    ) {
      return { status: 'live' }
    }
    await unlink(leasePath).catch(() => {})
  }
  return verdict
}

async function readLeaseRecord(leasePath: string): Promise<LeaseRecord | 'unreadable'> {
  try {
    const value: unknown = JSON.parse(await readFile(leasePath, 'utf8'))
    if (
      typeof value === 'object' &&
      value !== null &&
      'pid' in value &&
      'linuxStartTicks' in value &&
      'bootId' in value &&
      typeof value.pid === 'number' &&
      Number.isSafeInteger(value.pid) &&
      value.pid > 0 &&
      typeof value.linuxStartTicks === 'string' &&
      typeof value.bootId === 'string'
    ) {
      return { pid: value.pid, linuxStartTicks: value.linuxStartTicks, bootId: value.bootId }
    }
  } catch {}
  return 'unreadable'
}

async function isOlderThan(path: string, ageMs: number): Promise<boolean> {
  try {
    return Date.now() - (await lstat(path)).mtimeMs >= ageMs
  } catch {
    return true
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

export const linuxLeaseProcessReader: AppImageLeaseProcessReader = {
  readStartTicks(pid) {
    try {
      const startTicks = parseLinuxStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'))
      return startTicks ? { status: 'present', startTicks } : { status: 'unavailable' }
    } catch (error) {
      return hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ESRCH')
        ? { status: 'missing' }
        : { status: 'unavailable' }
    }
  },
  readBootId: readBootIdentity
}
