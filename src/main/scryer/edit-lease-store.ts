import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { scryerPaths } from './engine/paths'
import type { ModelEditLease } from './engine'

export type ScryerEditLease = ModelEditLease

export type AcquireScryerEditLeaseInput = {
  projectPath: string
  owner: NonNullable<ModelEditLease['owner']>
  agentRunId?: string
  token?: string
  expiresAt?: string
}

export type AcquireScryerEditLeaseResult =
  | {
      ok: true
      acquired: boolean
      lease: ScryerEditLease
    }
  | {
      ok: false
      reason: 'lease_conflict'
      activeLease: ScryerEditLease
    }

export type ReadScryerEditLeaseInput = {
  projectPath: string
}

export type ReleaseScryerEditLeaseInput = {
  projectPath: string
  token?: string
  agentRunId?: string
}

export type ReleaseScryerEditLeaseResult =
  | {
      ok: true
      released: boolean
    }
  | {
      ok: false
      reason: 'lease_mismatch'
      activeLease: ScryerEditLease
    }

export type ScryerEditLeaseStore = {
  acquire(input: AcquireScryerEditLeaseInput): Promise<AcquireScryerEditLeaseResult>
  read(input: ReadScryerEditLeaseInput): Promise<ScryerEditLease | null>
  release(input: ReleaseScryerEditLeaseInput): Promise<ReleaseScryerEditLeaseResult>
}

export type CreateScryerEditLeaseStoreOptions = {
  clock?: {
    nowIso(): string
  }
  tokens?: {
    next(): string
  }
}

function defaultClock() {
  return {
    nowIso() {
      return new Date().toISOString()
    }
  }
}

function defaultTokens() {
  return {
    next() {
      return `scryer-edit-${randomUUID()}`
    }
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

function parseLease(raw: string, path: string): ScryerEditLease {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Failed to parse Scryer edit lease at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Scryer edit lease at ${path} is not an object`)
  }
  const record = value as Record<string, unknown>
  if (typeof record.token !== 'string' || record.token.length === 0) {
    throw new Error(`Scryer edit lease at ${path} has no token`)
  }
  return {
    token: record.token,
    ...(record.owner === 'agent' || record.owner === 'human' || record.owner === 'system'
      ? { owner: record.owner }
      : {}),
    ...(typeof record.agentRunId === 'string' ? { agentRunId: record.agentRunId } : {}),
    ...(typeof record.createdAt === 'string' ? { createdAt: record.createdAt } : {}),
    ...(typeof record.expiresAt === 'string' ? { expiresAt: record.expiresAt } : {})
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmpPath = join(
    dirname(path),
    `.tmp.${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  )
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmpPath, path)
}

function matchesLeaseIntent(active: ScryerEditLease, input: AcquireScryerEditLeaseInput): boolean {
  if (input.token && active.token === input.token) {
    return true
  }
  return Boolean(
    input.agentRunId && active.agentRunId === input.agentRunId && active.owner === input.owner
  )
}

function matchesReleaseIdentity(
  active: ScryerEditLease,
  input: ReleaseScryerEditLeaseInput
): boolean {
  if (input.token && active.token !== input.token) {
    return false
  }
  if (input.agentRunId && active.agentRunId !== input.agentRunId) {
    return false
  }
  return true
}

export function createScryerEditLeaseStore(
  options: CreateScryerEditLeaseStoreOptions = {}
): ScryerEditLeaseStore {
  const clock = options.clock ?? defaultClock()
  const tokens = options.tokens ?? defaultTokens()

  async function read(input: ReadScryerEditLeaseInput): Promise<ScryerEditLease | null> {
    const path = scryerPaths(input.projectPath).leasePath
    try {
      return parseLease(await readFile(path, 'utf8'), path)
    } catch (error) {
      if (isNotFound(error)) {
        return null
      }
      throw error
    }
  }

  return {
    async acquire(input) {
      const activeLease = await read(input)
      if (activeLease) {
        return matchesLeaseIntent(activeLease, input)
          ? { ok: true, acquired: false, lease: activeLease }
          : { ok: false, reason: 'lease_conflict', activeLease }
      }
      const lease: ScryerEditLease = {
        token: input.token ?? tokens.next(),
        owner: input.owner,
        ...(input.agentRunId ? { agentRunId: input.agentRunId } : {}),
        createdAt: clock.nowIso(),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {})
      }
      await atomicWriteJson(scryerPaths(input.projectPath).leasePath, lease)
      return { ok: true, acquired: true, lease }
    },
    read,
    async release(input) {
      const activeLease = await read(input)
      if (!activeLease) {
        return { ok: true, released: false }
      }
      if (!matchesReleaseIdentity(activeLease, input)) {
        return { ok: false, reason: 'lease_mismatch', activeLease }
      }
      await rm(scryerPaths(input.projectPath).leasePath, { force: true })
      return { ok: true, released: true }
    }
  }
}
