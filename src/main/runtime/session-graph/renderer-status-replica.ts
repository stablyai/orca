import type { OrcaRuntimeWithRuntimeId } from '../construction/runtime-identity-state'
import type { AgentStatusEntry } from '../../../shared/agent-status/contracts/agent-status-types'
import {
  rendererStatusOccupantKey,
  type RendererStatusOccupant,
  type RendererStatusPublication,
  type RendererStatusRecord,
  type RendererStatusAck
} from '../../../shared/agent-status/renderer-status-publication'
import { shapeMobileTerminalStatus } from '../../../shared/agent-status/mobile-terminal-status-shaping'

export type RendererStatusMember = RendererStatusOccupant & {
  worktreeId: string
  statusSuppressionTitle: string
}

/** Read replica only; graph membership and accepted renderer rows remain separate inputs. */
export class RendererStatusReplica {
  private epoch: string | null = null
  private seq = 0
  private seeded = false
  private members = new Map<string, RendererStatusMember>()
  private membersByWorktree = new Map<string, Set<string>>()
  private pendingByPane = new Map<string, Set<string>>()
  private rows = new Map<string, RendererStatusRecord>()
  private pending = new Map<string, RendererStatusRecord>()
  private retired = new Set<string>()
  private active = new Map<string, string>()
  private bound = new Map<string, string>()

  beginEpoch(epoch: string): void {
    if (this.epoch === epoch) {
      return
    }
    this.epoch = epoch
    this.seq = 0
    this.seeded = false
    this.rows.clear()
    this.pending.clear()
    this.retired.clear()
    this.active.clear()
    this.bound.clear()
    this.pendingByPane.clear()
  }

  /** Only the generation that owes the seed holds phone frames; losing authority releases them. */
  awaitingSnapshot(worktreeId: string, generation: string | null): boolean {
    return generation === this.epoch && !this.seeded && this.membersByWorktree.has(worktreeId)
  }

  unseededWorktrees(): Iterable<string> {
    return this.seeded ? [] : this.membersByWorktree.keys()
  }

  *membersForWorktree(worktreeId: string): IterableIterator<RendererStatusMember> {
    for (const key of this.membersByWorktree.get(worktreeId) ?? []) {
      yield this.members.get(key)!
    }
  }

  reconcileGraph(
    incoming: Map<string, RendererStatusMember>,
    worktrees: ReadonlySet<string>
  ): Set<string> {
    const changed = new Set<string>()
    for (const worktreeId of worktrees) {
      const previous = this.membersByWorktree.get(worktreeId) ?? new Set<string>()
      for (const paneKey of previous) {
        const old = this.members.get(paneKey)!
        const next = incoming.get(paneKey)
        const priorPty = this.bound.get(paneKey) ?? old.rendererPtyId
        if (
          !next ||
          old.leafId !== next.leafId ||
          (priorPty !== null && next.rendererPtyId !== null && priorPty !== next.rendererPtyId)
        ) {
          const key = rendererStatusOccupantKey({ ...old, rendererPtyId: priorPty })
          const unbound = rendererStatusOccupantKey({ ...old, rendererPtyId: null })
          this.retireOutstanding(key, paneKey)
          this.retireOutstanding(unbound, paneKey)
          if (this.active.get(paneKey) === key || this.active.get(paneKey) === unbound) {
            this.active.delete(paneKey)
          }
          if (!next) {
            for (const pendingKey of this.pendingByPane.get(paneKey) ?? []) {
              this.retireOutstanding(pendingKey, paneKey)
            }
            this.pendingByPane.delete(paneKey)
            const active = this.active.get(paneKey)
            if (active) {
              this.retireOutstanding(active, paneKey)
              this.active.delete(paneKey)
            }
            this.bound.delete(paneKey)
          }
        }
        if (
          !next ||
          old.rendererPtyId !== next.rendererPtyId ||
          old.statusSuppressionTitle !== next.statusSuppressionTitle
        ) {
          changed.add(worktreeId)
        }
        this.members.delete(paneKey)
      }
      this.membersByWorktree.delete(worktreeId)
    }
    for (const [paneKey, member] of incoming) {
      this.members.set(paneKey, member)
      const keys = this.membersByWorktree.get(member.worktreeId) ?? new Set<string>()
      keys.add(paneKey)
      this.membersByWorktree.set(member.worktreeId, keys)
      if (member.rendererPtyId !== null) {
        this.bound.set(paneKey, member.rendererPtyId)
      }
      const activeKey = this.active.get(paneKey)
      const active = activeKey ? this.rows.get(activeKey) : undefined
      if (active && !this.matches(active, member)) {
        this.rows.delete(activeKey!)
        this.active.delete(paneKey)
        this.setPending(activeKey!, active)
      }
      for (const key of this.pendingByPane.get(paneKey) ?? []) {
        const record = this.pending.get(key)!
        if (this.matches(record, member)) {
          this.deletePending(key, paneKey)
          this.setActive(key, record)
          changed.add(member.worktreeId)
        }
      }
    }
    return changed
  }

  private setActive(key: string, record: RendererStatusRecord): void {
    const previous = this.active.get(record.paneKey)
    if (previous !== undefined) {
      this.rows.delete(previous)
    }
    this.rows.set(key, record)
    this.active.set(record.paneKey, key)
  }

  private retireOutstanding(key: string, paneKey: string): void {
    // An ordered tombstone already settled an absent row; graph removal creates no new debt.
    if ((this.active.get(paneKey) === key && this.rows.has(key)) || this.pending.has(key)) {
      this.retired.add(key)
    }
    this.rows.delete(key)
    this.deletePending(key, paneKey)
  }

  private deletePending(key: string, paneKey: string): void {
    this.pending.delete(key)
    const keys = this.pendingByPane.get(paneKey)
    keys?.delete(key)
    if (!keys?.size) {
      this.pendingByPane.delete(paneKey)
    }
  }

  private setPending(key: string, record: RendererStatusRecord): void {
    this.pending.set(key, record)
    const keys = this.pendingByPane.get(record.paneKey) ?? new Set<string>()
    keys.add(key)
    this.pendingByPane.set(record.paneKey, keys)
  }

  private matches(row: RendererStatusOccupant, member: RendererStatusMember): boolean {
    return (
      row.leafId === member.leafId &&
      (row.rendererPtyId === null ||
        member.rendererPtyId === null ||
        row.rendererPtyId === member.rendererPtyId)
    )
  }

  apply(batch: RendererStatusPublication): RendererStatusAck & { worktrees: Set<string> } {
    const worktrees = new Set<string>()
    if (batch.epoch !== this.epoch || !Number.isSafeInteger(batch.seq) || batch.seq <= this.seq) {
      return { accepted: false, worktrees }
    }
    if (batch.type !== 'snapshot' && (!this.seeded || batch.seq !== this.seq + 1)) {
      return { accepted: false, snapshotRequired: true, worktrees }
    }
    if (batch.type === 'snapshot') {
      for (const worktreeId of this.membersByWorktree.keys()) {
        worktrees.add(worktreeId)
      }
      this.retired.clear()
      this.rows.clear()
      this.active.clear()
      this.pending.clear()
      this.pendingByPane.clear()
      this.seeded = true
    }
    this.seq = batch.seq
    let snapshotRequired = false
    for (const record of batch.rows) {
      const key = rendererStatusOccupantKey(record)
      if (record.row !== null && this.retired.has(key)) {
        continue
      }
      const member = this.members.get(record.paneKey)
      this.rows.delete(key)
      this.deletePending(key, record.paneKey)
      if (record.row === null) {
        this.retired.delete(key)
        this.retired.delete(rendererStatusOccupantKey({ ...record, rendererPtyId: null }))
        if (this.active.get(record.paneKey) === key) {
          this.active.delete(record.paneKey)
        }
        if (member && this.matches(record, member)) {
          worktrees.add(member.worktreeId)
        }
        continue
      }
      if (member && this.matches(record, member)) {
        this.setActive(key, record)
        worktrees.add(member.worktreeId)
      } else {
        this.setPending(key, record)
        if (this.pending.size > 2048) {
          const oldest = this.pending.entries().next().value!
          this.deletePending(oldest[0], oldest[1].paneKey)
          snapshotRequired = true
        }
      }
    }
    return { accepted: true, ...(snapshotRequired ? { snapshotRequired } : {}), worktrees }
  }

  get(paneKey: string): { row: AgentStatusEntry | undefined } | undefined {
    const member = this.members.get(paneKey)
    if (!member) {
      return undefined
    }
    const key = this.active.get(paneKey)
    return {
      row: shapeMobileTerminalStatus(
        key ? (this.rows.get(key)?.row ?? undefined) : undefined,
        member.statusSuppressionTitle
      )
    }
  }
}

const replicas = new WeakMap<OrcaRuntimeWithRuntimeId, RendererStatusReplica>()
export function rendererStatusReplica(runtime: OrcaRuntimeWithRuntimeId): RendererStatusReplica {
  let replica = replicas.get(runtime)
  if (!replica) {
    replicas.set(runtime, (replica = new RendererStatusReplica()))
  }
  return replica
}
