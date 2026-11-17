import type { Translate } from '../i18n/mobile-i18n'

// A wake alone usually takes about 5 s, and a whole open (wake, access, connect) about 10-12 s:
// reassure only when the wake itself, or the run as a whole, runs clearly past that.
export const CLOUD_WAKE_SLOW_MS = 10_000
export const CLOUD_RUN_SLOW_MS = 20_000

/**
 * Which reassurance to show, if any. `waking` is the wake step itself (the prompt has not gone out
 * yet). `shownBefore`: once the note has appeared it stays for the rest of the run, so a long wake
 * hands over to the plain note in place instead of disappearing until the 20 s mark.
 */
export function cloudWakeSlowMessage(
  elapsedMs: number,
  args: { waking: boolean; promptQueued: boolean; shownBefore?: boolean },
  t: Translate
): string | null {
  const plain = (): string => t('cloud.wake.slow', 'Taking longer than usual. Your files are safe.')
  if (args.waking && elapsedMs >= CLOUD_WAKE_SLOW_MS) {
    return args.promptQueued
      ? t(
          'cloud.wake.slowQueued',
          'Taking longer than usual. Your files are safe. Your prompt sends as soon as it’s awake.'
        )
      : plain()
  }
  // Awake but still connecting or sending: the prompt sentence would no longer be true.
  return args.shownBefore || elapsedMs >= CLOUD_RUN_SLOW_MS ? plain() : null
}
