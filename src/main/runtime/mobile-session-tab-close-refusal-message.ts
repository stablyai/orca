import type { RuntimeMobileSessionTabCloseResult } from '../../shared/runtime-session-contracts'

type MobileSessionTabCloseRefusalReason = NonNullable<
  RuntimeMobileSessionTabCloseResult['refusalReason']
>

// Why: these reach a CLI user and a Sleep-workspace toast verbatim, so they must
// read as sentences. Avoid the substrings `describeSleepFailure` keys off
// ('legacy', 'terminal_', 'runtime', 'connection', 'Daemon') — a match there
// would relabel a refusal as an unreachable host.
const REFUSAL_MESSAGES: Record<MobileSessionTabCloseRefusalReason, string> = {
  'missing-intent':
    'The host had no record of a close for this terminal tab, so the tab was kept open.',
  'stale-publication':
    "This workspace's terminal tabs changed while the close was in flight, so the tab was kept open. Try again.",
  'stale-terminal':
    'A replacement terminal took this tab over while it was closing, so the tab was kept open. Try again.',
  'live-host-pty': 'This terminal still has a live process on its host, so the tab was kept open.',
  'unknown-liveness':
    "The host could not confirm whether this terminal's process is still running, so the tab was kept open.",
  'retirement-owner': 'Only the window that owns this terminal tab can close it.'
}

export function describeMobileSessionTabCloseRefusal(
  refusalReason: MobileSessionTabCloseRefusalReason | undefined
): string {
  return (
    (refusalReason && REFUSAL_MESSAGES[refusalReason]) ??
    'The host declined to close this terminal tab, so the tab was kept open.'
  )
}
