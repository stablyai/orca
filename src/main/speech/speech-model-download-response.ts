/** Shared response shape for Electron net and Node https. */
export type DownloadIncomingMessage = NodeJS.ReadableStream & {
  statusCode?: number
  headers: Record<string, string | string[] | undefined>
  destroy?: () => void
}

/** Host adapter for Electron net or Node https requests. */
export type SpeechDownloadRequest = {
  setHeader(name: string, value: string): void
  /** Returns detach; the Node adapter retains an error listener for abort after detach. */
  listen(listeners: {
    error: (error: Error) => void
    response: (response: DownloadIncomingMessage) => void
    redirect: (statusCode: number, method: string, redirectUrl: string) => void
  }): () => void
  abort(): void
  end(): void
}

/** Opens one GET; the host decides the network stack (Chromium on the desktop, Node on orcad). */
export type OpenSpeechDownloadRequest = (url: string) => SpeechDownloadRequest
export type DownloadTotals = {
  totalBytes: number
  completedBytes: number
  modelTotalBytes: number
}
export type ContentRange = { start: number; end: number; totalBytes?: number }

export const DOWNLOAD_IDLE_TIMEOUT_MS = 120_000
// Range-resume tolerates proxies that cut long CDN transfers.
export const DOWNLOAD_RETRY_DELAYS_MS = [1_000, 2_000, 4_000]
// Count consecutive stalls; progressing retries remain subject to the absolute request ceiling.
export const MAX_NO_PROGRESS_ATTEMPTS = DOWNLOAD_RETRY_DELAYS_MS.length + 1
// Bound tiny segments absolutely; 4096 covers ~1GB at ~256KB per range.
export const MAX_TOTAL_DOWNLOAD_REQUESTS = 4_096
// Surface longer Retry-After windows for manual retry instead of stalling indefinitely.
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
