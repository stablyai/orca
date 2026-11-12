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
  }

  reconcileGraph(
    incoming: Map<string, RendererStatusMember>,
    unchanged: ReadonlySet<string>
  ): Set<string> {
    for (const [key, member] of this.members) {
      if (unchanged.has(member.worktreeId) && !incoming.has(key)) {
        incoming.set(key, member)
      }
    }
    return this.reconcile(incoming)
  }

  reconcile(members: Map<string, RendererStatusMember>): Set<string> {
    const changed = new Set<string>()
    for (const [paneKey, old] of this.members) {
      const next = members.get(paneKey)
      const priorPty = this.bound.get(paneKey) ?? old.rendererPtyId
      if (
        !next ||
        (priorPty !== null && next.rendererPtyId !== null && priorPty !== next.rendererPtyId)
      ) {
        const key = rendererStatusOccupantKey({ ...old, rendererPtyId: priorPty })
        this.retired.add(key)
        this.active.delete(paneKey)
        this.rows.delete(key)
        this.pending.delete(key)
        // An unbound continuation belongs to the departed pane too.
        const unbound = rendererStatusOccupantKey({ ...old, rendererPtyId: null })
        this.rows.delete(unbound)
        this.pending.delete(unbound)
        if (!next) {
          this.retired.add(unbound)
          this.bound.delete(paneKey)
        }
      }
      if (
        !next ||
        old.rendererPtyId !== next.rendererPtyId ||
        old.statusSuppressionTitle !== next.statusSuppressionTitle
      ) {
        changed.add(old.worktreeId)
      }
    }
    for (const [paneKey, member] of members) {
      if (member.rendererPtyId !== null) {
        this.bound.set(paneKey, member.rendererPtyId)
      }
    }
    this.members = members
    for (const [key, record] of this.pending) {
      const member = members.get(record.paneKey)
      if (member && this.matches(record, member)) {
        this.pending.delete(key)
        this.rows.set(key, record)
        this.active.set(record.paneKey, key)
        changed.add(member.worktreeId)
      }
    }
    return changed
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
      for (const row of this.rows.values()) {
        const member = this.members.get(row.paneKey)
        if (member) {
          worktrees.add(member.worktreeId)
        }
      }
      this.rows.clear()
      this.active.clear()
      this.pending.clear()
      this.seeded = true
    }
    this.seq = batch.seq
    let snapshotRequired = false
    for (const record of batch.rows) {
      const key = rendererStatusOccupantKey(record)
      if (this.retired.has(key)) {
        continue
      }
      const member = this.members.get(record.paneKey)
      this.rows.delete(key)
      this.pending.delete(key)
      if (record.row === null) {
        if (this.active.get(record.paneKey) === key) {
          this.active.delete(record.paneKey)
        }
        if (member && this.matches(record, member)) {
          worktrees.add(member.worktreeId)
        }
        continue
      }
      if (member && this.matches(record, member)) {
        this.rows.set(key, record)
        this.active.set(record.paneKey, key)
        worktrees.add(member.worktreeId)
      } else {
        this.pending.set(key, record)
        if (this.pending.size > 2048) {
          this.pending.delete(this.pending.keys().next().value!)
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

const replicas = new WeakMap<object, RendererStatusReplica>()
export function rendererStatusReplica(runtime: object): RendererStatusReplica {
  let replica = replicas.get(runtime)
  if (!replica) {
    replicas.set(runtime, (replica = new RendererStatusReplica()))
  }
  return replica
}
