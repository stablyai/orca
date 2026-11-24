import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import * as SecureStore from 'expo-secure-store'
import * as z from 'zod'
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
const secretKey = (overviewId: string, scopeId: string): string =>
  `orca.activity.${overviewId}.${scopeId}`
const randomKey = (): string => (Crypto.randomUUID() + Crypto.randomUUID()).replaceAll('-', '')

async function readCohort(): Promise<LiveActivityCohort | null> {
  const raw = await AsyncStorage.getItem(KEY)
  const parsed = cohortSchema.safeParse(raw ? JSON.parse(raw) : null)
  return parsed.success ? parsed.data : null
}

export async function loadLiveActivityCohort(): Promise<LiveActivityCohort | null> {
  return runKeyedSerializedOperation(writes, KEY, readCohort)
}

export async function liveActivityScopeKey(
  cohort: LiveActivityCohort,
  scopeId: string
): Promise<string> {
  const value = await SecureStore.getItemAsync(secretKey(cohort.overviewId, scopeId))
  if (!value) {
    throw new Error('Missing Live Activity enrollment')
  }
  return value
}

async function deleteCohortSecrets(cohort: LiveActivityCohort): Promise<void> {
  await Promise.all(
    [...cohort.scopes.map((scope) => scope.id), 'control'].map((id) =>
      SecureStore.deleteItemAsync(secretKey(cohort.overviewId, id))
    )
  )
}

export async function forgetLiveActivityCohort(): Promise<void> {
  await runKeyedSerializedOperation(writes, KEY, async () => {
    const cohort = await readCohort()
    await AsyncStorage.removeItem(KEY)
    if (cohort) {
      await deleteCohortSecrets(cohort)
    }
  })
}

export async function discoverLiveActivitySources(
  clients: ReadonlyMap<string, RpcClient>
): Promise<{ sources: LiveActivitySource[]; complete: boolean }> {
  const catalog = await loadHostCatalog()
  let complete = catalog.every((host) => clients.has(host.id))
  const ids = new Set(catalog.map((host) => host.id))
  const saved = await AsyncStorage.getItem(CATALOG_KEY)
  const parsed = z.array(sourceSchema).safeParse(saved ? JSON.parse(saved) : [])
  let sources: LiveActivitySource[] = (parsed.success ? parsed.data : []).filter(
    (source) => ids.has(source.hostId) && source.executionHost
  )
  sources.push(...catalog.map((host) => ({ hostId: host.id })))
  for (const [hostId, client] of clients) {
    if (!ids.has(hostId)) {
      continue
    }
    const result = await relayHostsListRead
      .request(client, undefined, { timeoutMs: 5000, failWhenDisconnected: true })
      .then((reply) => relayHostsListRead.interpret(reply))
      .catch(() => null)
    if (!result?.accepted) {
      complete = false
      continue
    }
    sources = sources.filter((source) => source.hostId !== hostId || !source.executionHost)
    sources.push(...result.value.map((host) => ({ hostId, executionHost: host.hostId })))
  }
  sources.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  if (sources.length > 32) {
    throw new Error('Too many Live Activity sources')
  }
  await AsyncStorage.setItem(CATALOG_KEY, JSON.stringify(sources))
  return { sources, complete }
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
    const scopes: LiveActivityCohort['scopes'] = []
    for (const source of discovery.sources) {
      const value = randomKey()
      const id = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, value)
      await SecureStore.setItemAsync(secretKey(overviewId, id), value)
      scopes.push({ ...source, id })
    }
    const coordinator =
      scopes.find((scope) => scope.hostId === coordinatorHostId && !scope.executionHost) ??
      scopes.find((scope) => !scope.executionHost) ??
      scopes[0]
    if (!coordinator) {
      throw new Error('Live Activity coordinator unavailable')
    }
    const cohort = {
      overviewId,
      scopes,
      coordinatorScopeId: coordinator.id,
      controlRevision: 1,
      discoveryComplete: discovery.complete
    }
    await SecureStore.setItemAsync(secretKey(overviewId, 'control'), randomKey())
    if (!current()) {
      await deleteCohortSecrets(cohort)
      return null
    }
    await AsyncStorage.setItem(KEY, JSON.stringify(cohort))
    return cohort
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
