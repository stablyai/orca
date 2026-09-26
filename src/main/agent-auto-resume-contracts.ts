import type {
  AgentAutoResumePhase,
  AgentAutoResumeSnapshot,
  UsageLimitProvider,
  UsageLimitStallReason
} from '../shared/agent-auto-resume-types'
import type { UsageLimitStallSnapshot } from './runtime/orca-runtime'

// The service's tunables, its injected boundary and its per-PTY record, split
// out of the service itself: the class has to stay under this repository's
// max-lines ratchet, and these are exactly the parts callers and tests read
// rather than execute.

// Why: after a banner's reset time, give the provider a short cushion before
// resending so the agent CLI has actually cleared the limit server-side.
export const BANNER_RESET_GRACE_MS = 90 * 1000
// Why: some banners print no parseable reset (and the provider quota probe may
// be unavailable). Retry conservatively rather than hammering the CLI.
export const BANNER_UNKNOWN_RESET_DELAY_MS = 5 * 60 * 1000
// Why: after resending, wait before checking whether the agent recovered; a
// real resume flips the title to "working" within this window.
export const POST_SEND_VERIFY_MS = 45 * 1000
// Product rule: cap attempts and always notify on give-up.
export const MAX_RESUME_ATTEMPTS = 2
// Why: a frame the chooser parser cannot classify is not proof of anything, and
// a parked agent prints nothing that would re-arm the watcher, so a single
// unreadable read must not end the wait. Re-read on this cadence instead.
export const INDETERMINATE_RETRY_DELAY_MS = 30 * 1000
// ...but not forever: 10 re-reads (5 minutes) of a screen we still cannot parse
// is a give-up the user should hear about, not a wait that silently never ends.
export const MAX_INDETERMINATE_RETRIES = 10

export type AgentAutoResumeNotificationKind = 'detected' | 'failed' | 'dead-pty'

export type AgentAutoResumeNotification = {
  kind: AgentAutoResumeNotificationKind
  worktreeId: string | null
  paneKey: string | null
  provider: UsageLimitProvider | null
  reason: UsageLimitStallReason
  resumesAt: number | null
}

type SendKeysAction = { text?: string; enter?: boolean }

export type AgentAutoResumeServiceOptions = {
  /** Re-verify a stall against the live PTY tail immediately before acting. */
  verifyStall: (ptyId: string) => UsageLimitStallSnapshot | null
  /** Write keystrokes to the agent terminal identified by its runtime handle. */
  sendKeys: (handle: string, action: SendKeysAction) => Promise<void>
  /** Move the chooser's highlight onto "stop and wait for limit to reset" and
   *  confirm it, reading the menu out of the tail `verifyStall` just returned.
   *  Resolves false when that row could not be identified, which is a refusal to
   *  act, not a retryable error: the menu's ordering is server-controlled and one
   *  arrangement puts a paid option under the cursor. */
  chooseMenuReset: (ptyId: string, handle: string, menuText: string) => Promise<boolean>
  /** Per-terminal opt-in, keyed by the stall's paneKey: only terminals the user
   *  marked are ever tracked. Read live on every event so unticking the box takes
   *  effect immediately. */
  isWatchEnabled: (paneKey: string | null) => boolean
  /** The user-configured agent idle timeout, reused as the menu grace period. */
  getMenuGraceMs: () => number
  /** resetsAt from RateLimitService for the provider, if known. */
  getProviderResetAt?: (provider: UsageLimitProvider | null) => number | null
  /** Fire a native/mobile notification (already gated by NotificationSettings). */
  notify?: (notification: AgentAutoResumeNotification) => void
  /** Push the current tracked-entry snapshot to the renderer. */
  onSnapshot?: (snapshot: AgentAutoResumeSnapshot) => void
  now?: () => number
  logger?: Pick<Console, 'debug' | 'warn'>
}

export type TrackedStall = {
  ptyId: string
  handle: string
  worktreeId: string | null
  paneKey: string | null
  provider: UsageLimitProvider | null
  reason: UsageLimitStallReason
  resetsAt: number | null
  detectedAt: number
  phase: AgentAutoResumePhase
  attempts: number
  /** Re-reads spent on a screen the chooser parser could not classify. */
  indeterminateReads: number
  resumesAt: number | null
  timer: ReturnType<typeof setTimeout> | null
}

/** When to resend `continue` for a banner: after the later of the banner's own
 *  reset and the provider's, plus the cushion. A reset already in the past means
 *  the limit should have cleared, so the cushion is measured from now rather
 *  than from the stale timestamp. */
export function computeBannerResumeAt(
  stall: Pick<TrackedStall, 'resetsAt'>,
  providerResetAt: number | null,
  now: number
): number {
  const target = Math.max(stall.resetsAt ?? 0, providerResetAt ?? 0)
  if (target <= 0) {
    return now + BANNER_UNKNOWN_RESET_DELAY_MS
  }
  return Math.max(target, now) + BANNER_RESET_GRACE_MS
}
