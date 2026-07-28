import { DAEMON_PTY_HISTORY_SEED_MAX_BYTES } from './daemon-admission-limits'

// Why: the checkpoint writer may legally produce a snapshot larger than the daemon's seed ceiling
// (16 MiB vs 12 MiB), and the ceiling can't simply be raised — the seed rides inside a single
// createOrAttach request line capped at DAEMON_MAX_ACTIVE_REQUEST_BYTES_PER_CLIENT. Without a clamp
// the whole restore is rejected and the terminal comes back BLANK, which is strictly worse than
// coming back with older scrollback dropped. So clamp here, keeping the most recent output.

/**
 * Trims a restore seed to fit the daemon's admission ceiling, preserving the mode-rehydrate prefix
 * and the most recent scrollback. Returns the seed unchanged when it already fits.
 */
export function clampHistorySeed(
  prefix: string,
  body: string,
  maxBytes = DAEMON_PTY_HISTORY_SEED_MAX_BYTES
): string {
  const prefixBuffer = Buffer.from(prefix, 'utf8')
  const bodyBuffer = Buffer.from(body, 'utf8')
  if (prefixBuffer.length + bodyBuffer.length <= maxBytes) {
    return prefix + body
  }

  // Why: the prefix restores terminal modes (wrap, cursor keys, alt-screen). Dropping it to make
  // room would restore correct text into a misconfigured terminal, so the body yields instead.
  const bodyBudget = maxBytes - prefixBuffer.length
  if (bodyBudget <= 0) {
    return prefix
  }

  const tail = bodyBuffer.subarray(bodyBuffer.length - bodyBudget)
  // Why: cutting at an arbitrary offset can land mid-escape-sequence or mid-UTF-8-codepoint, which
  // renders as literal garbage. Resume at the first newline so the first surviving line is whole.
  const newlineIndex = tail.indexOf(0x0a)
  const aligned = newlineIndex === -1 ? tail : tail.subarray(newlineIndex + 1)
  return prefix + aligned.toString('utf8')
}
