import type {
  UsageLimitProvider,
  UsageLimitStallReason
} from '../../shared/agent-auto-resume-types'

export type PtyUsageLimitStall = {
  reason: UsageLimitStallReason
  resetsAt: number | null
  detectedAt: number
}

/** Emitted whenever a PTY's usage-limit state changes. Consumed by
 *  AgentAutoResumeService in the composition root. */
export type UsageLimitStallEvent =
  | {
      kind: 'detected'
      ptyId: string
      /** Always issued, never read-or-null: a stall the watcher cannot address is
       *  one it can only give up on, and unhandled panes are exactly the ones a
       *  restore leaves without a pre-allocated handle. */
      handle: string
      worktreeId: string | null
      paneKey: string | null
      provider: UsageLimitProvider | null
      reason: UsageLimitStallReason
      resetsAt: number | null
      detectedAt: number
    }
  | { kind: 'cleared'; ptyId: string }
  | {
      kind: 'exited'
      ptyId: string
      worktreeId: string | null
      paneKey: string | null
      exitCode: number
    }

/** Live re-verification of a PTY's usage-limit stall, read against the current
 *  tail just before the service acts (never against stale history). */
export type UsageLimitStallSnapshot = {
  ptyId: string
  handle: string | null
  worktreeId: string | null
  paneKey: string | null
  provider: UsageLimitProvider | null
  reason: UsageLimitStallReason
  resetsAt: number | null
  detectedAt: number
  /** Whether the recorded stall is confirmed live on screen right now — the only
   *  state in which the watcher may press a key. */
  actionable: boolean
  /** Whether the recorded stall is still on screen but could not be classified —
   *  a chooser frame the parser reads as neither live nor dismissed. Distinct
   *  from a plain `!actionable`, which the watcher treats as proof the stall is
   *  over: an indeterminate screen is worth re-reading instead, because dropping
   *  it strands an agent that will never print another byte to re-arm anything. */
  indeterminate: boolean
  /** Whether the pane may still be showing usage-limit UI, so nothing may be
   *  typed into it. Deliberately the opposite default to `actionable`: only a
   *  screen that proves the chooser is gone clears this, because a message typed
   *  into a live chooser confirms whichever row the CLI has highlighted. */
  blocksDelivery: boolean
  /** Whether the agent is currently working (a resumed agent must not be poked). */
  agentWorking: boolean
  /** Live tail the signal was matched against, for callers that must read the
   *  chooser's options rather than act on its presence alone. */
  waitText: string
}
