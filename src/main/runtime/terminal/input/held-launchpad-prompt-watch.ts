import { waitForAgentPromptDelay } from './agent-prompt-signals'

/** dsh-tui 0.15-0.20 refuse Enter until their session opens, which a loaded host can push past the
 *  in-band submit budget; a watch keeps pressing then, so no caller's wait or prompt lock grows. */
export const HELD_LAUNCHPAD_PROMPT_WATCH_TTL_MS = 5 * 60_000

export type HeldLaunchpadPromptWatchHost = {
  /** False once the PTY's process generation changed or its stop was requested. */
  isLive: () => boolean
  /** When input last reached the PTY, Orca's own writes included. */
  readLastInputAt: () => number | null
  /** True once a turn started, or a permission prompt or new process makes another Enter unsafe. */
  settled: () => Promise<boolean>
  /** Whether the composer still shows exactly our prompt; `absorbedEnters` as in isHeldAgentPromptDraft. */
  holdsPrompt: (absorbedEnters: number) => Promise<boolean>
  pressEnter: () => boolean
}

/** Press Enter every `retryDelayMs` while the composer holds our prompt. Stops on a turn start, any
 *  other input to the PTY, a changed or gone draft, a new process, `signal`, or the TTL. */
export async function watchHeldLaunchpadPrompt(
  host: HeldLaunchpadPromptWatchHost,
  args: { retryDelayMs: number; absorbedEnters: number; signal: AbortSignal; ttlMs?: number }
): Promise<number> {
  const deadline = Date.now() + (args.ttlMs ?? HELD_LAUNCHPAD_PROMPT_WATCH_TTL_MS)
  let absorbedEnters = args.absorbedEnters
  let ownInputAt = host.readLastInputAt()
  let presses = 0
  const othersTyped = (): boolean => host.readLastInputAt() !== ownInputAt
  while (Date.now() < deadline) {
    try {
      await waitForAgentPromptDelay(args.retryDelayMs, args.signal)
    } catch {
      return presses
    }
    if (!host.isLive() || othersTyped() || (await host.settled())) {
      return presses
    }
    if (!(await host.holdsPrompt(absorbedEnters))) {
      return presses
    }
    // Recheck after the screen read yielded: input landing meanwhile owns the composer now.
    if (args.signal.aborted || !host.isLive() || othersTyped() || !host.pressEnter()) {
      return presses
    }
    ownInputAt = host.readLastInputAt()
    absorbedEnters += 1
    presses += 1
  }
  return presses
}
