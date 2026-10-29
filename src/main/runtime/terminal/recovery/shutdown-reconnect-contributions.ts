import { ContributionOverlay } from './reconnect-contribution-overlay'
export { ContributionOverlay } from './reconnect-contribution-overlay'
import { copySessionRecord } from '../../../../shared/session-record-edit'

import type { SessionUnitIndex } from '../../../../shared/session-unit-index'
import {
  SessionUnitReader,
  readSessionUnit,
  type SessionUnitView
} from '../../../../shared/session-unit-reader'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import {
  activeConnectionIdsFromTargets,
  tabReconnectPtys,
  type ReconnectFactSources,
  type ShutdownReconnectFacts
} from './shutdown-reconnect-facts'

export type OwnerFacts = {
  live: boolean
  tabs: readonly string[]
  relays: ReadonlyMap<string, { pty: string; position: number }>
}

export type Source = WorkspaceSessionState | SessionUnitView

export function ownerFacts(
  source: Source,
  owner: string,
  sources: ReconnectFactSources
): OwnerFacts {
  const rows = readSessionUnit(source, 'tabsByWorktree', owner) ?? []
  const relays = new Map<string, { pty: string; position: number }>()
  let live = false
  rows.forEach((tab, position) => {
    const panes = tabReconnectPtys(source, tab.id, tab.ptyId)
    if (panes.some((pane) => sources.isLiveLocalPty(pane.ptyId))) {
      live = true
    }
    const relay = panes.find(
      (pane) => !pane.sleeping && parseAppSshPtyId(pane.ptyId) && !sources.isKnownExited(pane.ptyId)
    )
    if (relay) {
      relays.set(tab.id, { pty: relay.ptyId, position: relays.get(tab.id)?.position ?? position })
    }
  })
  return { live, tabs: rows.map((tab) => tab.id), relays }
}

export class ReconnectContributions {
  initialized = false
  readonly dirtyOwners = new Set<string>()
  readonly dirtyPtys = new Set<string>()
  private owners = new ContributionOverlay<string, OwnerFacts>()
  private byTab = new ContributionOverlay<string, Map<string, { pty: string; position: number }>>()
  private relays: Record<string, string> = {}
  private active = new ContributionOverlay<string, true>()
  private activeIds: string[] = []
  private relayOrder = new ContributionOverlay<string, { owner: string; position: number }>()
  private targets = new ContributionOverlay<string, number>()
  private targetIds: string[] = []

  constructor(
    public root: WorkspaceSessionState,
    readonly index: SessionUnitIndex
  ) {}

  candidate(): ReconnectContributions {
    const copy = new ReconnectContributions(this.root, this.index)
    copy.initialized = true
    copy.owners = this.owners.candidate()
    copy.byTab = this.byTab.candidate()
    copy.relays = this.relays
    copy.active = this.active.candidate()
    copy.activeIds = this.activeIds
    copy.relayOrder = this.relayOrder.candidate()
    copy.targets = this.targets.candidate()
    copy.targetIds = this.targetIds
    return copy
  }

  refresh(sources: ReconnectFactSources): void {
    if (!this.initialized) {
      this.owners.clear()
      this.byTab.clear()
      this.relays = {}
      this.active.clear()
      this.activeIds = []
      this.targets.clear()
      this.targetIds = []
      this.relayOrder.clear()
      for (const owner of this.index.keys('tabsByWorktree')) {
        this.dirtyOwners.add(owner)
      }
      this.initialized = true
    }
    const reader = new SessionUnitReader(this.root, this.index)
    const selection = reader.selectReferences(
      [...this.dirtyPtys].map((id) => ({ kind: 'pty', id }))
    )
    for (const owner of reader.affectedOwners(selection)) {
      this.dirtyOwners.add(owner)
    }
    this.update(
      this.root,
      this.dirtyOwners,
      sources,
      (keys) => this.index.ordered('tabsByWorktree', keys),
      (tab) => reader.terminalOwners(tab)
    )
    this.dirtyOwners.clear()
    this.dirtyPtys.clear()
  }

  update(
    source: Source,
    owners: Iterable<string>,
    sources: ReconnectFactSources,
    ordered: (keys: Iterable<string>) => readonly string[],
    peers: (tab: string) => readonly string[],
    reorder = false
  ): void {
    const affected = new Set(owners),
      tabs = new Set<string>()
    for (const owner of affected) {
      const previous = this.owners.get(owner),
        next = ownerFacts(source, owner, sources)
      this.owners.set(owner, next)
      for (const tab of new Set([...(previous?.relays.keys() ?? []), ...next.relays.keys()])) {
        tabs.add(tab)
        const contributions = new Map(this.byTab.get(tab))
        const value = next.relays.get(tab)
        if (value) {
          contributions.set(owner, value)
        } else {
          contributions.delete(owner)
        }
        if (contributions.size) {
          this.byTab.set(tab, contributions)
        } else {
          this.byTab.delete(tab)
        }
      }
    }
    let relayChanged = false
    const relays = copySessionRecord(this.relays)
    for (const tab of tabs) {
      const contributions = this.byTab.get(tab)
      const winner = ordered(contributions?.keys() ?? []).at(-1)
      const next = winner ? contributions?.get(winner)?.pty : undefined
      const first = ordered(contributions?.keys() ?? [])[0]
      const token = first
        ? { owner: first, position: contributions!.get(first)!.position }
        : undefined
      const oldToken = this.relayOrder.get(tab)
      if (token?.owner !== oldToken?.owner || token?.position !== oldToken?.position) {
        reorder = true
      }
      if (token) {
        this.relayOrder.set(tab, token)
      } else {
        this.relayOrder.delete(tab)
      }
      const prior = this.relays[tab]
      if (prior !== next) {
        relayChanged = true
        for (const [pty, delta] of [
          [prior, -1],
          [next, 1]
        ] as const) {
          const target = pty && parseAppSshPtyId(pty)?.connectionId
          if (!target) {
            continue
          }
          const count = (this.targets.get(target) ?? 0) + delta
          if (count) {
            this.targets.set(target, count)
          } else {
            this.targets.delete(target)
          }
        }
        if (next) {
          relays[tab] = next
        } else {
          delete relays[tab]
        }
      }
      for (const owner of peers(tab)) {
        affected.add(owner)
      }
    }
    if (relayChanged || reorder) {
      const token = (tab: string) => {
        const contributions = this.byTab.get(tab)!
        const owner = ordered(contributions.keys())[0]!
        return { owner, position: contributions.get(owner)!.position }
      }
      const keys = Object.keys(relays).sort((left, right) => {
        const a = token(left),
          b = token(right)
        return a.owner === b.owner
          ? a.position - b.position
          : ordered([a.owner, b.owner])[0] === a.owner
            ? -1
            : 1
      })
      this.relays = Object.fromEntries(keys.map((key) => [key, relays[key]]))
      this.targetIds = [
        ...new Set(
          Object.keys(this.relays).flatMap((key) => {
            const target = parseAppSshPtyId(relays[key])?.connectionId
            return target ? [target] : []
          })
        )
      ]
    }
    let membershipChanged = false
    for (const owner of affected) {
      const facts = this.owners.get(owner)
      const active = Boolean(facts && (facts.live || facts.tabs.some((tab) => this.relays[tab])))
      if (this.active.has(owner) === active) {
        continue
      }
      membershipChanged = true
      if (active) {
        this.active.set(owner, true)
      } else {
        this.active.delete(owner)
      }
    }
    if (membershipChanged || reorder) {
      this.activeIds = [...ordered(this.active)]
    }
  }

  facts(
    sources: ReconnectFactSources,
    others: readonly ReconnectContributions[]
  ): ShutdownReconnectFacts {
    // These are ordered counted aggregate keys; no session unit is revisited to emit the globals.
    const relayTargets = [...this.targetIds, ...others.flatMap((other) => other.targetIds)]
    return {
      activeWorktreeIdsOnShutdown: this.activeIds,
      remoteSessionIdsByTabId: this.byTab.size ? this.relays : undefined,
      activeConnectionIdsAtShutdown: activeConnectionIdsFromTargets(sources, relayTargets)
    }
  }
}
