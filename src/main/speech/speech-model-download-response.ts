export type DownloadIncomingMessage = Electron.IncomingMessage &
  NodeJS.ReadableStream & {
    headers: Record<string, string | string[] | undefined>
    destroy?: () => void
  }
export type DownloadTotals = {
  totalBytes: number
  completedBytes: number
  modelTotalBytes: number
}
export type ContentRange = { start: number; end: number; totalBytes?: number }

export const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000
// Why: flaky networks/proxies often kill long CDN transfers near the end; Range-resume lets them finish.
export const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
// Why: count only CONSECUTIVE no-progress attempts, so a download still advancing across drops is never abandoned.
export const MAX_NO_PROGRESS_ATTEMPTS = DOWNLOAD_RETRY_DELAYS_MS.length + 1
// Why: absolute backstop against a tiny-segment server; 4096 covers the ~1GB model even at a proxy's ~256KB min range.
export const MAX_TOTAL_DOWNLOAD_REQUESTS = 4_096
// Why: cap honored Retry-After; a longer server window is surfaced for manual retry, not a multi-minute stall.
export const MAX_RETRY_AFTER_MS = 120_000
export function getHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

export function parseContentRange(value: string | string[] | undefined): ContentRange | null {
  const match = getHeaderValue(value)
    ?.trim()
    .match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i)
  if (!match) {
    return null
  }
  const start = Number.parseInt(match[1], 10)
  const end = Number.parseInt(match[2], 10)
  const totalBytes = match[3] === '*' ? undefined : Number.parseInt(match[3], 10)
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    end < start ||
    (totalBytes !== undefined && (!Number.isSafeInteger(totalBytes) || totalBytes <= end))
  ) {
    return null
  }
  return { start, end, totalBytes }
}

export function parseRetryAfterMs(value: string | string[] | undefined): number | undefined {
  const header = getHeaderValue(value)?.trim()
  if (!header) {
    return undefined
  }
  if (/^\d+$/.test(header)) {
    const seconds = Number.parseInt(header, 10)
    const delayMs = seconds * 1_000
    return Number.isSafeInteger(delayMs) ? delayMs : undefined
  }
  const retryAt = Date.parse(header)
  return Number.isNaN(retryAt) ? undefined : Math.max(0, retryAt - Date.now())
}

export function describeInterruptedDownload(
  cause: unknown,
  receivedBytes: number,
  totalBytes: number,
  attempts: number
): Error {
  const causeMessage = cause instanceof Error ? cause.message : String(cause)
  const received =
    totalBytes > 0
      ? `${Math.min(99, Math.floor((receivedBytes / totalBytes) * 100))}% (${receivedBytes} of ${totalBytes} bytes)`
      : `${receivedBytes} bytes`
  return new Error(
    `Model download interrupted at ${received} after ${attempts} attempts: ${causeMessage}`
  )
}

export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
