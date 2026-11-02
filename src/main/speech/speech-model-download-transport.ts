import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import {
  DOWNLOAD_RETRY_DELAYS_MS,
  MAX_NO_PROGRESS_ATTEMPTS,
  MAX_RETRY_AFTER_MS,
  MAX_TOTAL_DOWNLOAD_REQUESTS,
  describeInterruptedDownload,
  type DownloadTotals
} from './speech-model-download-response'
import { isRetryableDownloadError, type HttpStatusError } from '../network/transient-download-error'
import { SpeechModelHttpDownload } from './speech-model-http-download'
import { delayUnlessAborted } from '../../shared/abort-aware-delay'

export abstract class SpeechModelDownloadTransport extends SpeechModelHttpDownload {
  protected getPartialDownloadBytes(filePath: string): number {
    try {
      return statSync(filePath).size
    } catch {
      return 0
    }
  }

  protected async downloadFileWithRetry(
    url: string,
    filePath: string,
    expectedSize: number,
    modelId: string,
    isAborted: () => boolean,
    signal: AbortSignal,
    completedBytes = 0,
    modelTotalBytes = expectedSize
  ): Promise<void> {
    let requestCount = 0
    let noProgressStreak = 0
    const totals: DownloadTotals = { totalBytes: expectedSize, completedBytes, modelTotalBytes }
    for (;;) {
      requestCount += 1
      const offset = this.getPartialDownloadBytes(filePath)
      // The final write can precede transport failure; SHA-256 remains authoritative.
      if (offset === totals.totalBytes) {
        return
      }
      // Bound servers that advance forever without finishing.
      if (requestCount > MAX_TOTAL_DOWNLOAD_REQUESTS) {
        throw describeInterruptedDownload(
          new Error('too many download requests'),
          offset,
          totals.totalBytes,
          requestCount - 1
        )
      }
      try {
        // Restart from the canonical URL because signed CDN redirects expire.
        await this.downloadFile(
          url,
          filePath,
          expectedSize,
          modelId,
          isAborted,
          signal,
          0,
          offset,
          totals
        )
        const receivedBytes = this.getPartialDownloadBytes(filePath)
        if (receivedBytes === totals.totalBytes) {
          return
        }
        if (receivedBytes > totals.totalBytes) {
          throw new Error(
            `Model download exceeded its expected size (${receivedBytes} of ${totals.totalBytes} bytes)`
          )
        }
        const incompleteResponse: HttpStatusError = new Error(
          `Model download response ended at ${receivedBytes} of ${totals.totalBytes} bytes`
        )
        if (receivedBytes > offset) {
          // Range-capping proxies require another segment immediately; progress resets stalls.
          noProgressStreak = 0
          continue
        }
        incompleteResponse.retryable = true
        throw incompleteResponse
      } catch (err) {
        if (isAborted() || signal.aborted) {
          throw err
        }
        const receivedBytes = this.getPartialDownloadBytes(filePath)
        if (receivedBytes === totals.totalBytes) {
          return
        }
        noProgressStreak = receivedBytes > offset ? 0 : noProgressStreak + 1
        if (!isRetryableDownloadError(err)) {
          throw err
        }
        // Bound consecutive stalls independently of the total request ceiling.
        if (noProgressStreak >= MAX_NO_PROGRESS_ATTEMPTS) {
          throw describeInterruptedDownload(err, receivedBytes, totals.totalBytes, requestCount)
        }
        const statusError: HttpStatusError | undefined = err instanceof Error ? err : undefined
        const retryAfterMs = statusError?.retryAfterMs
        if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
          throw new Error(
            `HTTP ${statusError?.httpStatusCode}; server requested retry after ${Math.ceil(retryAfterMs / 1_000)} seconds`
          )
        }
        console.warn(
          `[speech] Model download attempt ${requestCount} failed, retrying:`,
          modelId,
          err
        )
        await delayUnlessAborted(
          retryAfterMs ??
            DOWNLOAD_RETRY_DELAYS_MS[
              Math.min(Math.max(0, noProgressStreak - 1), DOWNLOAD_RETRY_DELAYS_MS.length - 1)
            ],
          signal
        )
      }
    }
  }

  protected verifyFileSha256(filePath: string, expectedSha256: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(filePath)
      let settled = false

      const cleanup = (): void => {
        stream.off('data', onData)
        stream.off('error', onError)
        stream.off('end', onEnd)
      }
      const settleResolve = (): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve()
      }
      const settleReject = (error: Error): void => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }
      const onData = (chunk: string | Buffer): void => {
        hash.update(chunk)
      }
      const onError = (error: Error): void => {
        settleReject(error)
      }
      const onEnd = (): void => {
        const actualSha256 = hash.digest('hex')
        if (actualSha256 !== expectedSha256.toLowerCase()) {
          // Verify artifacts before feeding native runtimes.
          settleReject(new Error('Downloaded model file failed integrity verification'))
          return
        }
        settleResolve()
      }

      stream.on('data', onData)
      stream.on('error', onError)
      stream.on('end', onEnd)
    })
  }
}
