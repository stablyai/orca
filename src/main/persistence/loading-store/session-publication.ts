import type { PublicationState, Partition, SessionRefSnapshot } from './session-publication-types'
export type { SessionRefSnapshot, PublicationState, Partition } from './session-publication-types'
import { mergeSessionChanges } from './session-change-coalescing'
import { SessionPublicationResources, type SessionAliasSink } from './session-publication-resources'
import {
  registerReconnectRoot,
  publishReconnectRoot
} from '../../runtime/terminal/recovery/shutdown-reconnect-fact-index'
import { SessionUnitReader, type PreparedSession } from '../../../shared/session-unit-reader'
import { sessionBindingIndex } from './session-binding-index'
import { sessionNormalizationRepos } from './session-normalization-catalog'

import { randomUUID } from 'node:crypto'

import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type {
  SessionAdmissionKind,
  SessionChangeSet,
  SessionMapField
} from '../../../shared/session-change-set'
import { SessionUnitIndex, type SessionUnitAddress } from '../../../shared/session-unit-index'

type SessionRootOwner = { state: PublicationState; hostId: ExecutionHostId }
const rootOwners = new WeakMap<WorkspaceSessionState, SessionRootOwner>()
const publications = new WeakMap<PublicationState, SessionPublication>()

export function sessionIndexForRoot(root: WorkspaceSessionState): SessionUnitIndex | undefined {
  const owner = rootOwners.get(root)
  return owner ? sessionPublication(owner.state).partition(owner.hostId).index : undefined
}

export function sessionPublication(state: PublicationState): SessionPublication {
  let publication = publications.get(state)
  if (!publication) {
    publication = new SessionPublication(state)
    publications.set(state, publication)
  }
  return publication
}

export function initializeSessionPublication(
  state: PublicationState,
  durableState: PublicationState = state,
  publishAliases?: SessionAliasSink
): void {
  publications.get(state)?.dispose()
  publications.set(state, new SessionPublication(state, durableState, publishAliases))
}

export function disposeSessionPublication(state: PublicationState): void {
  publications.get(state)?.dispose()
}

export class SessionPublication {
  private readonly resources: SessionPublicationResources
  private readonly epoch = randomUUID()
  private readonly partitions = new Map<ExecutionHostId, Partition>()

  private readonly pending = new Map<ExecutionHostId, SessionChangeSet[]>()

  constructor(
    private readonly state: PublicationState,
    durableState: PublicationState = state,
    publishAliases?: SessionAliasSink
  ) {
    this.resources = new SessionPublicationResources(this.epoch, this.partitions, publishAliases)
    if (state.sshRemotePtyLeases) {
      sessionBindingIndex(state.sshRemotePtyLeases)
    }
    if (state.repos) {
      sessionNormalizationRepos(state.repos, new Map())
    }
    this.partition(LOCAL_EXECUTION_HOST_ID)
    for (const key of Object.keys(state.workspaceSessionsByHostId ?? {})) {
      const hostId = normalizeExecutionHostId(key)
      if (hostId) {
        this.partition(hostId)
      }
    }
    this.resources.initialize(state, durableState)
  }

  partition(hostId: ExecutionHostId): Partition {
    let partition = this.partitions.get(hostId)
    if (!partition) {
      const root =
        (hostId === LOCAL_EXECUTION_HOST_ID
          ? this.state.workspaceSession
          : this.state.workspaceSessionsByHostId?.[hostId]) ?? getDefaultWorkspaceSession()
      const index = new SessionUnitIndex(root)
      partition = {
        root,
        index,
        generation: 0,
        versions: new Map(),
        aliases: new Map(),
        refs: Object.fromEntries(
          [...index.scrollbackRefs()].map((ref) => [ref, index.scrollbackCount(ref)])
        )
      }
      this.partitions.set(hostId, partition)
      rootOwners.set(root, { state: this.state, hostId })
      registerReconnectRoot(root, index)
      for (const tabId of Object.keys(root.terminalLayoutsByTabId ?? {})) {
        this.resources.updateAliasRecipes(hostId, tabId, root)
      }
    }
    return partition
  }

  generation(hostId: ExecutionHostId): string {
    return `${this.epoch}:${this.partition(hostId).generation}`
  }

  dispose(): void {
    this.resources.dispose()
  }
  captureRefs(dirtyDomains: ReadonlySet<string> | null): SessionRefSnapshot {
    return this.resources.captureRefs(dirtyDomains)
  }
  finishRefs(...args: Parameters<SessionPublicationResources['finishRefs']>): void {
    this.resources.finishRefs(...args)
  }

  version(hostId: ExecutionHostId, field: SessionMapField, key: string): number {
    return this.partition(hostId).versions.get(JSON.stringify([field, key])) ?? 0
  }

  take(hostId?: ExecutionHostId): SessionChangeSet[] {
    if (hostId !== undefined) {
      const events = this.pending.get(hostId) ?? []
      this.pending.delete(hostId)
      return events.length ? [mergeSessionChanges(events)] : []
    }
    const events = [...this.pending.values()].map(mergeSessionChanges)
    this.pending.clear()
    return events
  }

  publish(hostId: ExecutionHostId, admission: PreparedSession): SessionChangeSet {
    const partition = this.partition(hostId)
    const prior = partition.root
    if (admission.prior !== prior) {
      throw new Error('Session preparation captured a superseded root')
    }
    const next = admission.root
    const units = admission.units
    const { tabs, panes, files, pages, repos } = admission.affected
    const owners = new Set(admission.affected.owners)
    const addresses: SessionUnitAddress[] = units.flatMap((unit) =>
      unit.key === null ? [] : [{ field: unit.field, key: unit.key }]
    )
    for (const owner of admission.relatedViews?.keys() ?? []) {
      owners.add(owner)
    }
    if (!units.length && !admission.fullReplacement && !admission.relatedViews?.size) {
      for (const effect of admission.effects) {
        effect()
      }
      return {
        hostId,
        kind: admission.kind,
        generation: partition.generation,
        fullReplacement: false,
        units,
        owners,
        tabs,
        panes,
        files,
        pages,
        repos
      }
    }
    for (const { field, key } of units) {
      const id = JSON.stringify([field, key])
      partition.versions.set(id, (partition.versions.get(id) ?? 0) + 1)
    }
    const refDeltas = new Map<string, number>()
    for (const address of addresses) {
      for (const ref of partition.index.ids(address.field, address.key, 'scrollback')) {
        refDeltas.set(
          ref,
          (refDeltas.get(ref) ?? 0) -
            partition.index.scrollbackUnitCount(address.field, address.key, ref)
        )
      }
    }
    for (const unit of units) {
      if (unit.key !== null) {
        partition.index.replace(unit.field, unit.key, unit.next, unit.nextPresent)
      }
    }
    for (const [field, keys] of admission.orders) {
      partition.index.orderField(field, keys)
    }
    for (const address of addresses) {
      for (const ref of partition.index.ids(address.field, address.key, 'scrollback')) {
        refDeltas.set(
          ref,
          (refDeltas.get(ref) ?? 0) +
            partition.index.scrollbackUnitCount(address.field, address.key, ref)
        )
      }
    }
    if ([...refDeltas.values()].some((delta) => delta !== 0)) {
      const refs = { ...partition.refs }
      for (const [ref, delta] of refDeltas) {
        const count = (refs[ref] ?? 0) + delta
        if (count) {
          refs[ref] = count
        } else {
          delete refs[ref]
        }
      }
      partition.refs = refs
    }
    this.resources.noteRefs(refDeltas)
    rootOwners.delete(prior)
    rootOwners.set(next, { state: this.state, hostId })
    partition.root = next
    for (const tabId of tabs) {
      this.resources.updateAliasRecipes(hostId, tabId, next)
    }
    partition.generation += 1
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      this.state.workspaceSession = next
    } else if (admission.partitionDeleted) {
      const remaining = { ...this.state.workspaceSessionsByHostId }
      delete remaining[hostId]
      this.state.workspaceSessionsByHostId = remaining
    } else {
      this.state.workspaceSessionsByHostId = {
        ...this.state.workspaceSessionsByHostId,
        [hostId]: next
      }
    }
    const event: SessionChangeSet = {
      hostId,
      kind: admission.kind,
      generation: partition.generation,
      fullReplacement: admission.fullReplacement,
      units,
      owners,
      tabs,
      panes,
      files,
      pages,
      repos,
      editorViews: admission.relatedViews
    }
    for (const effect of admission.effects) {
      effect()
    }
    publishReconnectRoot(next, partition.index, event, admission.orders.has('tabsByWorktree'))
    const pending = this.pending.get(hostId) ?? []
    pending.push(event)
    this.pending.set(hostId, pending)
    return event
  }
}

export function publishSessionChanges(
  state: PublicationState,
  hostId: ExecutionHostId,
  admission: Parameters<SessionPublication['publish']>[1]
): SessionChangeSet {
  return sessionPublication(state).publish(hostId, admission)
}

/** Whole-session ingress and deletion prepare through the same reader as keyed operations. */
export function publishSessionReplacement(
  state: PublicationState,
  hostId: ExecutionHostId,
  session: WorkspaceSessionState | undefined,
  kind: SessionAdmissionKind = 'fullReplacement',
  relatedViews?: ReadonlyMap<string, { prior: unknown; next: unknown }>
): SessionChangeSet {
  const { root, index } = sessionPublication(state).partition(hostId)
  const reader = SessionUnitReader.between(root, session ?? getDefaultWorkspaceSession(), index)
  return publishSessionChanges(
    state,
    hostId,
    reader.prepare({
      kind,
      fullReplacement: true,
      partitionDeleted: session === undefined,
      relatedViews
    })
  )
}
