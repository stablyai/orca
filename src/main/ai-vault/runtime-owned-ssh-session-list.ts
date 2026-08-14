import {
  AI_VAULT_SCOPE_PATHS_MAX_COUNT,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import type {
  AiVaultSessionTitlesArgs,
  AiVaultSessionTitlesResult
} from '../../shared/ai-vault-session-title'
import {
  isRuntimeOwnedSshTargetId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { callRuntimeEnvironment } from '../ipc/runtime-environment-transport-routing'
import { parseAiVaultListResult } from './session-list-result-validation'
import { parseAiVaultSessionTitlesResult } from './session-title-result-validation'
import { aiVaultScanIssueResult, restampAiVaultListResult } from './session-list-results'

export type RuntimeOwnedSshAiVaultHost = {
  environmentId: string
  targetId: string
  executionHostId: `ssh:${string}`
  connected?: boolean
}

export type RuntimeOwnedSshAiVaultScanOptions = {
  timeoutMs?: number
}

const UNSUPPORTED_SSH_HOST_PARAM = /invalid (runtime )?execution host id/i
const OWNER_CACHE_TTL_MS = 60_000
const OWNER_CACHE_MAX_ENTRIES = 256

type CachedRuntimeOwnedSshHost = {
  owner: RuntimeOwnedSshAiVaultHost | null
  expiresAt: number
}

// Missing-title refreshes run every 20s; cache by pairing identity so they do not fan out to every runtime.
const cachedOwners = new Map<string, CachedRuntimeOwnedSshHost>()
type RuntimeOwnedSshHostLookup = {
  owner: RuntimeOwnedSshAiVaultHost | null
  cacheable: boolean
}
const inFlightOwnerLookups = new Map<string, Promise<RuntimeOwnedSshHostLookup>>()

export async function listRuntimeOwnedSshAiVaultTargets(
  userDataPath: string,
  environmentId: string,
  options: RuntimeOwnedSshAiVaultScanOptions = {}
): Promise<readonly RuntimeOwnedSshAiVaultHost[]> {
  return (await loadRuntimeOwnedSshAiVaultTargets(userDataPath, environmentId, options)).hosts
}

async function loadRuntimeOwnedSshAiVaultTargets(
  userDataPath: string,
  environmentId: string,
  options: RuntimeOwnedSshAiVaultScanOptions
): Promise<{ hosts: readonly RuntimeOwnedSshAiVaultHost[]; authoritative: boolean }> {
  let response: Awaited<ReturnType<typeof callRuntimeEnvironment>>
  try {
    response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'ssh.listTargetSummaries',
      undefined,
      options.timeoutMs
    )
  } catch {
    return { hosts: [], authoritative: false }
  }
  if (response.ok !== true || !isTargetSummaryList(response.result)) {
    return { hosts: [], authoritative: false }
  }
  const hosts = response.result.targets.flatMap((target) => {
    if (
      typeof target !== 'object' ||
      target === null ||
      !('id' in target) ||
      typeof target.id !== 'string' ||
      target.id.length === 0
    ) {
      return []
    }
    if (isRuntimeOwnedSshTargetId(target.id)) {
      return []
    }
    let executionHostId: `ssh:${string}`
    try {
      executionHostId = toSshExecutionHostId(target.id)
    } catch {
      return []
    }
    return [
      {
        environmentId,
        targetId: target.id,
        executionHostId,
        ...('connected' in target && typeof target.connected === 'boolean'
          ? { connected: target.connected }
          : {})
      }
    ]
  })
  return { hosts, authoritative: true }
}

export async function findRuntimeOwningSshAiVaultHost(
  userDataPath: string,
  targetId: string,
  options: RuntimeOwnedSshAiVaultScanOptions = {}
): Promise<RuntimeOwnedSshAiVaultHost | null> {
  if (isRuntimeOwnedSshTargetId(targetId)) {
    return null
  }
  const environments = listEnvironments(userDataPath)
  const cacheKey = JSON.stringify({
    userDataPath,
    targetId,
    environments: environments
      .map((environment) => ({
        id: environment.id,
        pairingRevision: environment.pairingRevision ?? environment.createdAt,
        runtimeId: environment.runtimeId
      }))
      .sort((a, b) => a.id.localeCompare(b.id))
  })
  const cached = cachedOwners.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.owner
  }
  const inFlight = inFlightOwnerLookups.get(cacheKey)
  if (inFlight) {
    return (await inFlight).owner
  }
  const lookup = findRuntimeOwnedSshHostInInventories(
    userDataPath,
    targetId,
    environments.map((environment) => environment.id),
    options
  )
  inFlightOwnerLookups.set(cacheKey, lookup)
  try {
    const result = await lookup
    if (result.cacheable) {
      cacheRuntimeOwnedSshHost(cacheKey, result.owner)
    }
    return result.owner
  } finally {
    if (inFlightOwnerLookups.get(cacheKey) === lookup) {
      inFlightOwnerLookups.delete(cacheKey)
    }
  }
}

async function findRuntimeOwnedSshHostInInventories(
  userDataPath: string,
  targetId: string,
  environmentIds: readonly string[],
  options: RuntimeOwnedSshAiVaultScanOptions
): Promise<RuntimeOwnedSshHostLookup> {
  const inventories = await Promise.all(
    environmentIds.map((environmentId) =>
      loadRuntimeOwnedSshAiVaultTargets(userDataPath, environmentId, options)
    )
  )
  const owner = inventories
    .flatMap((inventory) => inventory.hosts)
    .find((host) => host.targetId === targetId)
  return {
    owner: owner ?? null,
    cacheable: owner !== undefined || inventories.every((inventory) => inventory.authoritative)
  }
}

function cacheRuntimeOwnedSshHost(
  cacheKey: string,
  owner: RuntimeOwnedSshAiVaultHost | null
): void {
  const now = Date.now()
  for (const [key, entry] of cachedOwners) {
    if (entry.expiresAt <= now) {
      cachedOwners.delete(key)
    }
  }
  if (!cachedOwners.has(cacheKey) && cachedOwners.size >= OWNER_CACHE_MAX_ENTRIES) {
    const oldestKey = cachedOwners.keys().next().value
    if (oldestKey) {
      cachedOwners.delete(oldestKey)
    }
  }
  cachedOwners.set(cacheKey, { owner, expiresAt: now + OWNER_CACHE_TTL_MS })
}

export function resetRuntimeOwnedSshOwnerCacheForTests(): void {
  cachedOwners.clear()
  inFlightOwnerLookups.clear()
}

export async function scanRuntimeOwnedSshAiVaultSessions(
  userDataPath: string,
  environmentId: string,
  targetId: string,
  args: AiVaultListArgs,
  options: RuntimeOwnedSshAiVaultScanOptions = {}
): Promise<AiVaultListResult> {
  const executionHostId = toSshExecutionHostId(targetId)
  let response: Awaited<ReturnType<typeof callRuntimeEnvironment>>
  try {
    response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'aiVault.listSessions',
      {
        limit: args.limit,
        unlimited: args.unlimited,
        force: args.force,
        scopePaths: args.scopePaths?.slice(0, AI_VAULT_SCOPE_PATHS_MAX_COUNT),
        executionHostId
      },
      options.timeoutMs
    )
  } catch (error) {
    return aiVaultScanIssueResult({
      executionHostId,
      path: targetId,
      message: error instanceof Error ? error.message : 'Remote Orca server is unavailable.'
    })
  }
  if (response.ok !== true) {
    return aiVaultScanIssueResult({
      executionHostId,
      path: targetId,
      message: unsupportedSshHostMessage(response.error.message)
    })
  }
  try {
    return restampAiVaultListResult(parseAiVaultListResult(response.result), executionHostId)
  } catch (error) {
    return aiVaultScanIssueResult({
      executionHostId,
      path: targetId,
      message: `Invalid aiVault.listSessions response: ${
        error instanceof Error ? error.message : 'unexpected result shape'
      }`
    })
  }
}

export async function resolveRuntimeOwnedSshAiVaultSessionTitles(
  userDataPath: string,
  environmentId: string,
  targetId: string,
  args: AiVaultSessionTitlesArgs
): Promise<AiVaultSessionTitlesResult> {
  const executionHostId: ExecutionHostId = toSshExecutionHostId(targetId)
  let response: Awaited<ReturnType<typeof callRuntimeEnvironment>>
  try {
    response = await callRuntimeEnvironment(
      userDataPath,
      environmentId,
      'aiVault.resolveSessionTitles',
      { requests: args.requests, executionHostId }
    )
  } catch {
    return { titles: [] }
  }
  if (response.ok !== true) {
    return { titles: [] }
  }
  try {
    return parseAiVaultSessionTitlesResult(response.result)
  } catch {
    return { titles: [] }
  }
}

function unsupportedSshHostMessage(message: string): string {
  if (UNSUPPORTED_SSH_HOST_PARAM.test(message)) {
    return 'This Orca server cannot scan Agent Session History on its SSH hosts. Update the server and try again.'
  }
  return message
}

function isTargetSummaryList(value: unknown): value is { targets: unknown[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { targets?: unknown }).targets)
  )
}
