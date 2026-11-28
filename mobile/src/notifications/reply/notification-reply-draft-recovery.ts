import { delayUnlessAborted } from '../../../../src/shared/concurrency/abort-aware-delay'

const RETRY_DELAYS = [250, 500, 1000, 2000, 4000] as const

export async function recoverNotificationReplyDrafts(
  attempt: () => Promise<boolean>,
  signal: AbortSignal
): Promise<void> {
  for (let index = 0; index <= RETRY_DELAYS.length && !signal.aborted; index += 1) {
    if (await attempt().catch(() => false)) {
      return
    }
    const delay = RETRY_DELAYS[index]
    if (delay === undefined || signal.aborted) {
      return
    }
    await delayUnlessAborted(delay, signal)
  }
}
