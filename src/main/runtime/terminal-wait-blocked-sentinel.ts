import { TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE } from '../../shared/terminal-credential-prompt-detection'

/** Cheap negative scan run per retained tail line, so only candidate-bearing tails parse in full. */
export const TERMINAL_WAIT_BLOCKED_SENTINEL_RE =
  /update available|choose working directory to|codex just got an upgrade|hooks need review|do you trust|trust this|trusted workspace|press enter to (?:confirm|continue|view|insert)|press t to trust|permission required|requires permission|allow once|allow always|run this command\?/i

/** Whether `text` can carry any blocked signal, credential prompts included. */
export function mayContainTerminalWaitBlockedSentinel(text: string): boolean {
  return (
    TERMINAL_WAIT_BLOCKED_SENTINEL_RE.test(text) ||
    TERMINAL_CREDENTIAL_PROMPT_SENTINEL_RE.test(text)
  )
}
