import { rateLimitSpentUntil } from '../../../../shared/agent-usage/rate-limits/rate-limit-spent-windows'
import { switchFreeIdentity, type SwitchReset } from './structured-agent-session-usage-limit-chain'
import type { UsageLimitAccountScope } from './structured-agent-session-usage-limit-account-hold'

type Limited = { turnItemId: string; resetsAt: number; turnEndedAt?: number } & SwitchReset
type Seen = { cut: string; scope: string; spentAt?: number; roomAt?: number }

/** Per chat, readings of its launch scope since its cut's turn ended, before the cut's reset. A
 *  later one with room than one that showed it spent frees the cut then: a new login in the same
 *  folder, or a limit lifted early. Room alone never does, since a reading may miss the limit hit. */
export class UsageLimitAccountRoom {
  private readonly seen = new Map<string, Seen>()

  /** The cut with its reset brought forward to when its chat moved accounts or its scope showed
   *  room; later spending still holds it as for any reset. */
  freed<T extends Limited>(
    id: string,
    limited: T,
    scope: UsageLimitAccountScope | undefined,
    movedAt = Infinity
  ): T {
    const roomAt = this.at(id, limited, scope) ?? Infinity
    return { ...limited, resetsAt: Math.min(limited.resetsAt, movedAt, roomAt) }
  }

  /** When the scope showed room after spending; once seen it stands. */
  private at(
    id: string,
    limited: Limited,
    scope: UsageLimitAccountScope | undefined
  ): number | undefined {
    const cut = switchFreeIdentity(limited)
    let seen = this.seen.get(id)
    if (seen?.cut !== cut || (scope && seen.scope !== scope.scope)) {
      if (!scope) {
        return undefined
      }
      seen = { cut, scope: scope.scope }
      this.seen.set(id, seen)
    }
    const reading = scope?.account?.read()
    if (
      seen.roomAt === undefined &&
      limited.turnEndedAt !== undefined &&
      reading?.status === 'ok' &&
      reading.usageMetadata?.source !== 'live-session' &&
      reading.updatedAt >= limited.turnEndedAt &&
      reading.updatedAt < limited.resetsAt
    ) {
      if (rateLimitSpentUntil(reading) !== undefined) {
        seen.spentAt = Math.max(seen.spentAt ?? reading.updatedAt, reading.updatedAt)
      } else if (seen.spentAt !== undefined && reading.updatedAt > seen.spentAt) {
        seen.roomAt = reading.updatedAt
      }
    }
    return seen.roomAt
  }

  retain(shown: ReadonlySet<string>): void {
    for (const id of this.seen.keys()) {
      if (!shown.has(id)) {
        this.seen.delete(id)
      }
    }
  }

  clear(): void {
    this.seen.clear()
  }
}
