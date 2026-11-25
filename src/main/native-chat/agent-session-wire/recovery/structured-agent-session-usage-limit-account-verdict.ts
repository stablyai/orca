import {
  rateLimitShowsRoom,
  rateLimitSpentUntil
} from '../../../../shared/agent-usage/rate-limits/rate-limit-spent-windows'
import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS } from '../../../../shared/native-chat/transcript/continuation/native-chat-usage-limit-cut'
import type { SwitchReset } from './structured-agent-session-usage-limit-chain'
import type {
  UsageLimitAccountScope,
  UsageLimitAccountVerdict
} from './structured-agent-session-usage-limit-account-types'

export type UsageLimitAccountHold = {
  cut: string
  scope?: string
  account?: string
  heldUntil?: number
  unknownReset?: boolean
  spentSeenAt?: number
  refreshedFor?: number
  bootstrapSince?: { reset: number; at: number }
}

const GRACE_MS = 15_000
const READING_WAIT_MS = 120_000

export function accountHoldVerdict({
  cut,
  movedCut,
  awaitingRoom,
  spentHolds,
  scope,
  hold,
  now,
  roomAt
}: {
  cut: { turnItemId: string; resetsAt: number; turnEndedAt?: number } & SwitchReset
  movedCut: boolean
  awaitingRoom: boolean
  spentHolds: boolean
  scope: UsageLimitAccountScope | undefined
  hold: UsageLimitAccountHold
  now: number
  roomAt: (
    account: string | undefined,
    reading: ProviderRateLimits | null | undefined
  ) => number | undefined
}): UsageLimitAccountVerdict {
  const account = scope?.account
  const reading = account?.read()
  const fresh = (since: number) =>
    reading?.status === 'ok' &&
    reading.usageMetadata?.source !== 'live-session' &&
    reading.updatedAt >= since
  const covering =
    account && reading && fresh(cut.resetsAt) && rateLimitSpentUntil(reading, cut.resetsAt)
  const anchor = Math.max(
    cut.resetsAt,
    hold.heldUntil ?? cut.resetsAt,
    (hold.unknownReset && hold.spentSeenAt) || cut.resetsAt,
    typeof covering === 'number' ? covering : cut.resetsAt
  )
  const spentUntil = account && reading && rateLimitSpentUntil(reading)
  // A spent reading always holds a still-recoverable moved or relaunched cut, even when the reading
  // itself is older than its turn. It cannot make an expired task eligible again.
  if (
    reading &&
    spentHolds &&
    spentUntil !== undefined &&
    now - cut.resetsAt <= NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS
  ) {
    if (spentUntil === null) {
      hold.unknownReset = true
    } else {
      hold.heldUntil = Math.max(hold.heldUntil ?? spentUntil, spentUntil)
    }
    hold.spentSeenAt = Math.max(hold.spentSeenAt ?? reading.updatedAt, reading.updatedAt)
  }
  if (
    account &&
    reading &&
    fresh(movedCut ? (cut.turnEndedAt ?? Number.NEGATIVE_INFINITY) : cut.resetsAt) &&
    now - anchor <= NATIVE_CHAT_USAGE_LIMIT_MAX_OVERDUE_MS
  ) {
    if (typeof covering === 'number') {
      hold.heldUntil = Math.max(hold.heldUntil ?? covering, covering)
    }
    if (spentUntil !== undefined) {
      if (spentUntil === null) {
        hold.unknownReset = true
      } else {
        hold.heldUntil = Math.max(hold.heldUntil ?? spentUntil, spentUntil)
      }
      hold.spentSeenAt = Math.max(hold.spentSeenAt ?? reading.updatedAt, reading.updatedAt)
    } else if (
      fresh(cut.resetsAt) &&
      reading.updatedAt > (hold.spentSeenAt ?? Number.NEGATIVE_INFINITY)
    ) {
      if (hold.unknownReset || (hold.heldUntil ?? Number.NEGATIVE_INFINITY) > reading.updatedAt) {
        hold.heldUntil = reading.updatedAt
      }
      hold.unknownReset = false
    }
  }
  const room =
    movedCut &&
    reading &&
    fresh(cut.turnEndedAt ?? Number.NEGATIVE_INFINITY) &&
    rateLimitShowsRoom(reading)
      ? reading.updatedAt
      : roomAt(account?.key, reading)
  if (awaitingRoom && room !== undefined) {
    hold.unknownReset = false
  }
  const heldTo = Math.max(
    cut.resetsAt,
    hold.heldUntil ?? cut.resetsAt,
    (hold.unknownReset && hold.spentSeenAt) || cut.resetsAt
  )
  const roomReleases = room !== undefined && !hold.unknownReset && (awaitingRoom || room < heldTo)
  const releasedByRoom = roomReleases && awaitingRoom
  const resetsAt = roomReleases ? room : heldTo
  let waitFrom = resetsAt + GRACE_MS
  if (!account && scope?.bootstrap && now >= waitFrom) {
    if (hold.bootstrapSince?.reset !== resetsAt) {
      hold.bootstrapSince = { reset: resetsAt, at: now }
    }
    waitFrom = Math.max(waitFrom, hold.bootstrapSince.at)
  }
  return {
    resetsAt,
    unknownReset: hold.unknownReset === true,
    awaitingReading:
      (account ? !fresh(resetsAt) : scope?.bootstrap !== undefined) &&
      now >= waitFrom &&
      now < waitFrom + READING_WAIT_MS,
    awaitingRoom: awaitingRoom && room === undefined,
    releasedByRoom
  }
}
