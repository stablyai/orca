export const TERMINAL_DOUBLE_TAP_TAB_MAX_DELAY_MS = 300

export type TerminalTapRecord = {
  readonly handle: string
  readonly at: number
}

export type TerminalDoubleTapTabResult = {
  readonly sendTab: boolean
  readonly nextTap: TerminalTapRecord | null
}

export function resolveTerminalDoubleTapTab({
  enabled,
  handle,
  lastTap,
  now
}: {
  enabled: boolean
  handle: string
  lastTap: TerminalTapRecord | null
  now: number
}): TerminalDoubleTapTabResult {
  if (!enabled) {
    return { sendTab: false, nextTap: null }
  }

  const elapsed = lastTap?.handle === handle ? now - lastTap.at : null
  if (elapsed !== null && elapsed >= 0 && elapsed <= TERMINAL_DOUBLE_TAP_TAB_MAX_DELAY_MS) {
    return { sendTab: true, nextTap: null }
  }

  return { sendTab: false, nextTap: { handle, at: now } }
}
