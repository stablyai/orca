import { parseBrowserNetworkExecutionHostKey } from '../../../../shared/browser/client-hosting/browser-network-execution-host'
import { browserNetworkExecutionHostStorageIdentity } from '../../../browser/routing/identity/browser-execution-host-storage-identity'
import type { BrowserHostLeaseState } from '../leases/browser-host-lease-records'
import type { InitializationRecord } from './browser-host-page-initialization-records'

type Waiter = { ready(): void; retired(): void }
type Partition = { predecessors: Set<InitializationRecord>; waiting: Set<Waiter> }
type Profile = { partitions: Map<string | null, Partition>; predecessors: number }
type Scope = {
  connection: symbol
  sealed: boolean
  profiles: Map<string, Profile>
  members: Map<InitializationRecord, string | null>
}

// Dependency membership never certifies native destruction; only the exact page close can remove it.
export class BrowserHostPagePartitionPreparation {
  private readonly scopes = new Map<symbol, Scope>()

  observe(state: BrowserHostLeaseState): void {
    const scope = this.scope(state)
    scope.connection = state.connectionToken
    scope.sealed = false
  }

  seal(state: BrowserHostLeaseState): void {
    const scope = this.scope(state)
    if (scope.connection !== state.connectionToken) {
      return
    }
    scope.sealed = true
    for (const [id, profile] of scope.profiles) {
      this.drainProfile(scope, id, profile)
    }
  }

  register(state: BrowserHostLeaseState, record: InitializationRecord): void {
    if (!record.target) {
      return
    }
    const scope = this.scope(state)
    if (scope.members.has(record)) {
      return
    }
    const key = partitionGroup(record.targetExecutionHostKey)
    this.partition(scope, record.browserProfileId, key).predecessors.add(record)
    scope.profiles.get(record.browserProfileId)!.predecessors += 1
    scope.members.set(record, key)
  }

  joined(state: BrowserHostLeaseState, record: InitializationRecord): void {
    const scope = this.scopes.get(state.token)
    const profile = scope?.profiles.get(record.browserProfileId)
    if (!scope || !profile || !scope.members.has(record)) {
      return
    }
    const key = scope.members.get(record)!
    scope.members.delete(record)
    profile.partitions.get(key)?.predecessors.delete(record)
    profile.predecessors -= 1
    if (key === null && !profile.partitions.get(null)?.predecessors.size) {
      // The final unclassified predecessor releases every dependent group in this profile.
      this.drainProfile(scope, record.browserProfileId, profile)
    } else {
      this.drain(scope, record.browserProfileId, profile, key)
      this.drain(scope, record.browserProfileId, profile, null)
    }
  }

  isPrepared(state: BrowserHostLeaseState, profileId: string, key: string): boolean {
    const scope = this.scopes.get(state.token)
    if (!scope || !scope.sealed || scope.connection !== state.connectionToken) {
      return false
    }
    const profile = scope.profiles.get(profileId)
    if (!profile) {
      return true
    }
    const group = partitionGroup(key)
    return (
      !profile.partitions.get(null)?.predecessors.size &&
      !profile.partitions.get(group)?.predecessors.size &&
      (group !== null || profile.predecessors === 0)
    )
  }

  wait(
    state: BrowserHostLeaseState,
    profileId: string,
    key: string,
    ready: () => void,
    retired: () => void
  ): () => void {
    const scope = this.scope(state)
    const group = partitionGroup(key)
    const partition = this.partition(scope, profileId, group)
    const profile = scope.profiles.get(profileId)!
    const waiter = { ready, retired }
    partition.waiting.add(waiter)
    this.drain(scope, profileId, profile, group)
    return () => {
      partition.waiting.delete(waiter)
      this.drain(scope, profileId, profile, group)
    }
  }

  retire(state: BrowserHostLeaseState): void {
    const scope = this.scopes.get(state.token)
    this.scopes.delete(state.token)
    for (const profile of scope?.profiles.values() ?? []) {
      for (const partition of profile.partitions.values()) {
        for (const waiter of partition.waiting) {
          waiter.retired()
        }
      }
    }
  }

  private scope(state: BrowserHostLeaseState): Scope {
    let scope = this.scopes.get(state.token)
    if (!scope) {
      scope = {
        connection: state.connectionToken,
        sealed: false,
        profiles: new Map(),
        members: new Map()
      }
      this.scopes.set(state.token, scope)
    }
    return scope
  }

  private partition(scope: Scope, id: string, key: string | null): Partition {
    let profile = scope.profiles.get(id)
    if (!profile) {
      profile = { partitions: new Map(), predecessors: 0 }
      scope.profiles.set(id, profile)
    }
    let partition = profile.partitions.get(key)
    if (!partition) {
      partition = { predecessors: new Set(), waiting: new Set() }
      profile.partitions.set(key, partition)
    }
    return partition
  }

  private drainProfile(scope: Scope, id: string, profile: Profile): void {
    const keys = [...profile.partitions.keys()]
    for (const key of keys) {
      this.drain(scope, id, profile, key)
    }
  }

  private drain(scope: Scope, id: string, profile: Profile, key: string | null): void {
    const partition = profile.partitions.get(key)
    if (!partition || scope.profiles.get(id) !== profile) {
      return
    }
    const ready =
      scope.sealed &&
      !profile.partitions.get(null)?.predecessors.size &&
      !partition.predecessors.size &&
      (key !== null || profile.predecessors === 0)
    const waiting = ready ? [...partition.waiting] : []
    if (ready) {
      partition.waiting.clear()
    }
    if (!partition.waiting.size && !partition.predecessors.size) {
      profile.partitions.delete(key)
    }
    if (!profile.partitions.size) {
      scope.profiles.delete(id)
    }
    for (const waiter of waiting) {
      waiter.ready()
    }
  }
}

function partitionGroup(key: string | undefined): string | null {
  if (key === undefined) {
    return null
  }
  try {
    // The lease already fixes authority storage scope and client profile; reuse native host equality.
    return browserNetworkExecutionHostStorageIdentity(
      parseBrowserNetworkExecutionHostKey(key),
      'lease'
    )
  } catch {
    return null
  }
}
