import { AsyncLocalStorage } from 'node:async_hooks'
import { isRecord } from '../../../../shared/agent-status/child-work/agent-status-child-work-value-guards'
import {
  BROWSER_EXPECTED_URL_MISMATCH_CODE,
  clipUrlForMismatch,
  expectedUrlMismatchMessage,
  isSameBrowserUrl,
  type BrowserExpectedUrlMismatch
} from '../../../../shared/browser/client-hosting/browser-expected-url'
import { BrowserError } from '../../browser-error'

export function browserExpectedUrlMismatchError(
  mismatch: BrowserExpectedUrlMismatch
): BrowserError {
  return new BrowserError(
    BROWSER_EXPECTED_URL_MISMATCH_CODE,
    expectedUrlMismatchMessage(mismatch),
    mismatch
  )
}

/** One guarded command. A check narrows the gap before a side effect; it is not a lock on the page. */
export class ExpectedPageUrlGuard {
  private checkedUrl: string | undefined
  private stepStarted = false

  constructor(
    private readonly expectedUrl: string,
    private readonly browserPageId: string
  ) {}

  verify(liveUrls: readonly string[]): void {
    const actualUrl = liveUrls.find((url) => !isSameBrowserUrl(url, this.expectedUrl))
    if (actualUrl !== undefined) {
      throw browserExpectedUrlMismatchError({
        expectedUrl: this.expectedUrl,
        actualUrl: clipUrlForMismatch(actualUrl),
        browserPageId: this.browserPageId,
        mayHaveStarted: this.stepStarted
      })
    }
    this.checkedUrl = liveUrls[0]
  }

  verifyStep(liveUrls: readonly string[]): void {
    this.verify(liveUrls)
    this.stepStarted = true
  }

  /** Names the URL the last check saw; the action itself may have navigated since. */
  withReceipt<T>(result: T): T {
    return isRecord(result)
      ? { ...result, browserPageId: this.browserPageId, checkedUrl: this.checkedUrl }
      : result
  }
}

// Queued commands run under the caller ahead of them, so the queue reads this at enqueue.
const requestedPageUrl = new AsyncLocalStorage<string>()
const stepCheck = new AsyncLocalStorage<() => void>()

/** Lets the command below an RPC handler see the URL its caller expects. */
export function runWithRequestedPageUrl<T>(params: unknown, run: () => T): T {
  return isRecord(params) && typeof params.expectUrl === 'string'
    ? requestedPageUrl.run(params.expectUrl, run)
    : run()
}

export function getRequestedPageUrl(): string | undefined {
  return requestedPageUrl.getStore()
}

/** Checks now, then again at every step `run` announces with assertExpectedPageUrlForStep. */
export async function runExpectingPageUrl<T>(
  expectedUrl: string,
  browserPageId: string,
  readLiveUrls: () => readonly string[],
  run: () => Promise<T>
): Promise<T> {
  const guard = new ExpectedPageUrlGuard(expectedUrl, browserPageId)
  guard.verify(readLiveUrls())
  const result = await stepCheck.run(() => guard.verifyStep(readLiveUrls()), run)
  return guard.withReceipt(result)
}

/** Call right before a guarded command touches the page; does nothing for an unguarded one. */
export function assertExpectedPageUrlForStep(): void {
  stepCheck.getStore()?.()
}
