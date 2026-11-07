import { encodedJsonBytes } from '../../shared/generated-agent-input-notice'

/** Where a window's request to a paired host runs: that host's environment, the runtime it was
 *  sent to, the pairing it went over and this window's key there. Local metadata of this runtime's
 *  record only; it is never part of a notice another client reads. */
export type GeneratedInputNoticeOwner = {
  environmentId: string
  runtimeId?: string
  pairingRevision?: number
  window?: string
  terminal?: string
}
export type CompleteNoticeOwner = Required<Omit<GeneratedInputNoticeOwner, 'terminal'>> &
  Pick<GeneratedInputNoticeOwner, 'terminal'>

export function completeNoticeOwner(
  owner: GeneratedInputNoticeOwner | undefined
): CompleteNoticeOwner | null {
  return owner?.runtimeId && owner.window && owner.pairingRevision !== undefined
    ? {
        environmentId: owner.environmentId,
        runtimeId: owner.runtimeId,
        pairingRevision: owner.pairingRevision,
        window: owner.window,
        ...(owner.terminal ? { terminal: owner.terminal } : {})
      }
    : null
}

/** The same host runtime, pairing and window key: never a replacement under one environment. */
export function sameNoticeOwner(
  owner: GeneratedInputNoticeOwner,
  other: CompleteNoticeOwner
): boolean {
  return (
    owner.environmentId === other.environmentId &&
    owner.runtimeId === other.runtimeId &&
    owner.pairingRevision === other.pairingRevision &&
    owner.window === other.window
  )
}

/** One command owed to a paired host for one operation: give it this window's copy, or discard
 *  its own. Each is an immutable object, so an answer completes exactly the command it answers. */
export type GeneratedInputNoticeCommand =
  | { kind: 'register'; id: string; owner: CompleteNoticeOwner }
  | { kind: 'discard'; id: string; owner: CompleteNoticeOwner; origin: string | null }

type WithheldRow = { seq: number; id: string }

/** The owed commands: at most one per operation, a discard superseding a copy. Indexed by host,
 *  and the discards in owed order by the window that made them, which keeps that host's copy
 *  hidden: a window reads its own with a stable seek, however many there are. */
export class GeneratedInputNoticeCommands {
  private readonly current = new Map<string, GeneratedInputNoticeCommand>()
  private readonly byEnvironment = new Map<string, Set<string>>()
  private readonly withheldByOrigin = new Map<string, { rows: WithheldRow[]; live: number }>()
  private readonly withheldSeq = new Map<string, number>()
  private seq = 0
  /** Told when a host is owed work, so it is attempted at once. */
  onOwed: ((environmentId: string) => void) | null = null

  of(id: string): GeneratedInputNoticeCommand | undefined {
    return this.current.get(id)
  }

  /** A copy is owed only while no discard of the operation is; a discard replaces anything. */
  owe(command: GeneratedInputNoticeCommand): void {
    const was = this.current.get(command.id)
    if (command.kind === 'register' && was) {
      return
    }
    if (was) {
      this.drop(was)
    }
    this.current.set(command.id, command)
    this.add(this.byEnvironment, command.owner.environmentId, command.id)
    if (command.kind === 'discard' && command.origin) {
      this.withhold(command.origin, command.id)
    }
    this.onOwed?.(command.owner.environmentId)
  }

  /** The host answered this exact command: true when it was still the one owed. */
  complete(command: GeneratedInputNoticeCommand): boolean {
    if (this.current.get(command.id) !== command) {
      return false
    }
    this.drop(command)
    return true
  }

  /** The copy is no longer needed (the host keeps or never needs it); a discard is unaffected. */
  cancelRegister(id: string): void {
    const command = this.current.get(id)
    if (command?.kind === 'register') {
      this.drop(command)
    }
  }

  environments(): string[] {
    return [...this.byEnvironment.keys()]
  }

  /** The work owed to one host in owed order, read only as far as it is attempted. */
  *owedTo(environmentId: string): Generator<GeneratedInputNoticeCommand> {
    for (const id of this.byEnvironment.get(environmentId) ?? []) {
      const command = this.current.get(id)
      if (command) {
        yield command
      }
    }
  }

  isOwed(environmentId: string): boolean {
    return this.byEnvironment.has(environmentId)
  }

  /** `origin`'s withheld ids from seek position `from`, within `budget` encoded bytes. `next`
   *  resumes after the last one sent; removals between reads never shift a position. */
  withheldPage(
    origin: string,
    from: number,
    budget: number
  ): { ids: string[]; next: number | null; bytes: number } {
    const rows = this.withheldByOrigin.get(origin)?.rows ?? []
    let low = 0
    let high = rows.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (rows[mid].seq < from) {
        low = mid + 1
      } else {
        high = mid
      }
    }
    const ids: string[] = []
    let bytes = 0
    for (let at = low; at < rows.length; at += 1) {
      const { seq, id } = rows[at]
      if (this.withheldSeq.get(id) !== seq) {
        continue
      }
      const cost = encodedJsonBytes(id) + 1
      if (bytes + cost > budget && ids.length > 0) {
        return { ids, next: seq, bytes }
      }
      ids.push(id)
      bytes += cost
    }
    return { ids, next: null, bytes }
  }

  private withhold(origin: string, id: string): void {
    let withheld = this.withheldByOrigin.get(origin)
    if (!withheld) {
      withheld = { rows: [], live: 0 }
      this.withheldByOrigin.set(origin, withheld)
    }
    this.seq += 1
    withheld.rows.push({ seq: this.seq, id })
    withheld.live += 1
    this.withheldSeq.set(id, this.seq)
  }

  private drop(command: GeneratedInputNoticeCommand): void {
    this.current.delete(command.id)
    this.remove(this.byEnvironment, command.owner.environmentId, command.id)
    const origin = command.kind === 'discard' ? command.origin : null
    const withheld = origin ? this.withheldByOrigin.get(origin) : undefined
    if (origin && withheld && this.withheldSeq.delete(command.id)) {
      withheld.live -= 1
      // Amortized compaction keeps the seek index linear in what is still withheld.
      if (withheld.live === 0) {
        this.withheldByOrigin.delete(origin)
      } else if (withheld.rows.length > 2 * withheld.live + 16) {
        withheld.rows = withheld.rows.filter((row) => this.withheldSeq.get(row.id) === row.seq)
      }
    }
  }

  private add(index: Map<string, Set<string>>, key: string, id: string): void {
    let ids = index.get(key)
    if (!ids) {
      ids = new Set()
      index.set(key, ids)
    }
    ids.add(id)
  }

  private remove(index: Map<string, Set<string>>, key: string, id: string): void {
    const ids = index.get(key)
    if (ids?.delete(id) && ids.size === 0) {
      index.delete(key)
    }
  }
}
