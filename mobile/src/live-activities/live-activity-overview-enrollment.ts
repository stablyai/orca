import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import * as z from 'zod'
import {
  liveActivitySecretKey,
  rememberLiveActivitySecrets,
  cleanLiveActivitySecrets
} from './live-activity-enrollment-secrets'
import { runKeyedSerializedOperation } from '../../../src/shared/concurrency/keyed-serialized-operations'
import { loadHostCatalog } from '../host-catalog/host-store'
import { relayHostsListRead } from '../worktree/execution-hosts/server-workspace-operations'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'

const writes = new Map<string, Promise<void>>()
const KEY = 'orca:liveActivityOverview:v2'
const CATALOG_KEY = 'orca:liveActivitySources:v2'
const sourceSchema = z.object({ hostId: z.string(), executionHost: z.string().optional() })
const cohortSchema = z.object({
  overviewId: z.uuid(),
  coordinatorScopeId: z.string(),
  discoveryComplete: z.boolean(),
  controlRevision: z.number().int().positive(),
  tokenDigest: z.string().optional(),
  scopes: z
    .array(sourceSchema.extend({ id: z.string().regex(/^[a-f0-9]{64}$/) }))
    .min(1)
    .max(32)
})
export type LiveActivitySource = z.infer<typeof sourceSchema>
export type LiveActivityCohort = z.infer<typeof cohortSchema>
const randomKey = (): string => (Crypto.randomUUID() + Crypto.randomUUID()).replaceAll('-', '')

async function readCohort(): Promise<LiveActivityCohort | null> {
  const raw = await AsyncStorage.getItem(KEY)
  let value: unknown = null
  try {
    value = raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
  const parsed = cohortSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export async function loadLiveActivityCohort(): Promise<LiveActivityCohort | null> {
  return runKeyedSerializedOperation(writes, KEY, readCohort)
}

export async function liveActivityScopeKey(
  cohort: LiveActivityCohort,
  scopeId: string
): Promise<string> {
  const value = await SecureStore.getItemAsync(liveActivitySecretKey(cohort.overviewId, scopeId))
  if (!value) {
    throw new Error('Missing Live Activity enrollment')
  }
  return value
}

export async function cleanupLiveActivitySecrets(): Promise<void> {
  await runKeyedSerializedOperation(writes, KEY, async () => {
    await cleanLiveActivitySecrets((await readCohort())?.overviewId)
  })
}

export async function forgetLiveActivityCohort(expectedId?: string): Promise<void> {
  await runKeyedSerializedOperation(writes, KEY, async () => {
    const cohort = await readCohort()
    if (cohort && expectedId && cohort.overviewId !== expectedId) {
      return
    }
    if (cohort) {
      await rememberLiveActivitySecrets(
        cohort.overviewId,
        cohort.scopes.map((scope) => scope.id)
      )
    }
    await AsyncStorage.removeItem(KEY)
    await cleanLiveActivitySecrets()
  })
}

export async function discoverLiveActivitySources(
  clients: ReadonlyMap<string, RpcClient>,
  current: () => boolean = () => true
): Promise<{ sources: LiveActivitySource[]; complete: boolean }> {
  const catalog = await loadHostCatalog()
  const snapshot = new Map(clients)
  const surveyed = new Set<string>()
  const ids = new Set(catalog.map((host) => host.id))
  const saved = await AsyncStorage.getItem(CATALOG_KEY)
  const parsed = z.array(sourceSchema).safeParse(saved ? JSON.parse(saved) : [])
  let sources: LiveActivitySource[] = (parsed.success ? parsed.data : []).filter(
    (source) => ids.has(source.hostId) && source.executionHost
  )
  sources.push(...catalog.map((host) => ({ hostId: host.id })))
  for (const { id: hostId } of catalog) {
    if (!current()) {
      return { sources: [], complete: false }
    }
    const client = snapshot.get(hostId)
    if (!client) {
      continue
    }
    const result = await relayHostsListRead
      .request(client, undefined, { timeoutMs: 5000, failWhenDisconnected: true })
      .then((reply) => relayHostsListRead.interpret(reply))
      .catch(() => null)
    if (!result?.accepted) {
      continue
    }
    surveyed.add(hostId)
    sources = sources.filter((source) => source.hostId !== hostId || !source.executionHost)
    sources.push(...result.value.map((host) => ({ hostId, executionHost: host.hostId })))
  }
  sources.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (sources.length > 32) {
    throw new Error('Too many Live Activity sources')
  }
  if (!current()) {
    return { sources: [], complete: false }
  }
  await AsyncStorage.setItem(CATALOG_KEY, JSON.stringify(sources))
  return { sources, complete: catalog.every((host) => surveyed.has(host.id)) }
}

export async function createLiveActivityCohort(
  discovery: { sources: LiveActivitySource[]; complete: boolean },
  coordinatorHostId: string,
  current: () => boolean
): Promise<LiveActivityCohort | null> {
  return runKeyedSerializedOperation(writes, KEY, async () => {
    if (!current() || discovery.sources.length === 0) {
      return null
    }
    const overviewId = Crypto.randomUUID()
    const grants = await Promise.all(
      discovery.sources.map(async (source) => {
        const value = randomKey()
        const id = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value)
        return { scope: { ...source, id }, value }
      })
    )
    const scopes = grants.map(({ scope }) => scope)
    const coordinator =
      scopes.find((scope) => scope.hostId === coordinatorHostId && !scope.executionHost) ??
      scopes.find((scope) => !scope.executionHost) ??
      scopes[0]
    const cohort = {
      overviewId,
      scopes,
      coordinatorScopeId: coordinator.id,
      controlRevision: 1,
      discoveryComplete: discovery.complete
    }
    await rememberLiveActivitySecrets(
      overviewId,
      scopes.map((scope) => scope.id)
    )
    try {
      for (const { scope, value } of grants) {
        await SecureStore.setItemAsync(liveActivitySecretKey(overviewId, scope.id), value)
      }
      await SecureStore.setItemAsync(liveActivitySecretKey(overviewId, 'control'), randomKey())
      if (!current()) {
        await cleanLiveActivitySecrets((await readCohort())?.overviewId)
        return null
      }
      await AsyncStorage.setItem(KEY, JSON.stringify(cohort))
      await cleanLiveActivitySecrets(overviewId).catch(() => undefined)
      return cohort
    } catch (error) {
      await cleanLiveActivitySecrets((await readCohort())?.overviewId).catch(() => undefined)
      throw error
    }
  })
}

export function liveActivitySourcesMatch(
  cohort: LiveActivityCohort,
  discovery: { sources: LiveActivitySource[]; complete: boolean }
): boolean {
  return (
    cohort.discoveryComplete === discovery.complete &&
    JSON.stringify(
      cohort.scopes.map(({ hostId, executionHost }) => ({
        hostId,
        ...(executionHost ? { executionHost } : {})
      }))
    ) === JSON.stringify(discovery.sources)
  )
}

export async function saveLiveActivityCohort(
  cohort: LiveActivityCohort,
  current: () => boolean
): Promise<boolean> {
  return runKeyedSerializedOperation(writes, KEY, async () => {
    const stored = await readCohort()
    if (
      !current() ||
      stored?.overviewId !== cohort.overviewId ||
      stored.controlRevision > cohort.controlRevision
    ) {
      return false
    }
    await AsyncStorage.setItem(KEY, JSON.stringify(cohort))
    return current()
  })
}
