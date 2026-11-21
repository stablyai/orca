// A paired desktop's download that a feature claims when it begins (the desktop says which page and
// document started it). Claimed bytes stay in this host's memory and go only to that feature, never
// to the workspace; anything unclaimed takes the ordinary workspace path, untouched.

export type ClientDownloadStart = {
  browserPageId: string
  workspaceId: string
  pageHostGeneration: number
  filename: string
  documentUrl: string
}

export type ClientDownloadClaim = {
  maxBytes: number
  /** Shown on the desktop as where the download went. */
  label: string
  /** Receives the whole download, or why it never arrived; called exactly once. */
  take(download: { bytes: Buffer } | { reason: string }): Promise<void>
}

export type ClientDownloadClaimant = (start: ClientDownloadStart) => ClientDownloadClaim | null

type Pending = {
  start: ClientDownloadStart
  claim: ClientDownloadClaim
  chunks: Buffer[]
  received: number
  tooLarge: boolean
  /** Fails a download whose desktop went quiet (a dropped connection sends no abort). */
  idle: ReturnType<typeof setTimeout> | null
}

// The same quiet spell after which the workspace path gives up on a transfer.
const IDLE_MS = 3 * 60_000

// A desktop that begins and then vanishes must not hold memory forever.
const MAX_PENDING = 16

let claimant: ClientDownloadClaimant | null = null
const pending = new Map<string, Pending>()
// Claimed transfers already handed over or dropped: their late chunks must never reach the workspace.
const settled = new Set<string>()
const MAX_SETTLED = 256

export function setClientDownloadClaimant(next: ClientDownloadClaimant | null): void {
  claimant = next
}

const keyOf = (browserPageId: string, transferId: string): string =>
  `${browserPageId}\0${transferId}`

function settle(key: string, download: { bytes: Buffer } | { reason: string }): void {
  const entry = pending.get(key)
  if (!entry) {
    return
  }
  pending.delete(key)
  if (entry.idle) {
    clearTimeout(entry.idle)
  }
  settled.add(key)
  if (settled.size > MAX_SETTLED) {
    const [oldest] = settled
    settled.delete(oldest)
  }
  void entry.claim.take(download).catch((error: unknown) => {
    console.warn('[browser-downloads] a claimed download could not be handed over', error)
  })
}

function armIdle(key: string, entry: Pending): void {
  if (entry.idle) {
    clearTimeout(entry.idle)
  }
  entry.idle = setTimeout(
    () => settle(key, { reason: 'the download stopped arriving from the desktop.' }),
    IDLE_MS
  )
  entry.idle.unref?.()
}

/** Resolves whether a claimant took the download as it began. */
export function beginClientDownload(transferId: string, start: ClientDownloadStart): boolean {
  const claim = claimant?.(start) ?? null
  if (!claim) {
    return false
  }
  if (pending.size >= MAX_PENDING) {
    const [oldest] = pending.keys()
    settle(oldest, { reason: 'the download was dropped while too many were waiting.' })
  }
  const entry: Pending = { start, claim, chunks: [], received: 0, tooLarge: false, idle: null }
  const key = keyOf(start.browserPageId, transferId)
  pending.set(key, entry)
  armIdle(key, entry)
  return true
}

/** null when the transfer wasn't claimed; otherwise the write's acknowledgement. */
export function writeClaimedClientDownload(chunk: {
  browserPageId: string
  transferId: string
  pageHostGeneration: number
  contentBase64: string
  offset: number
  final: boolean
}): { workspaceRelativePath?: string } | null {
  const key = keyOf(chunk.browserPageId, chunk.transferId)
  if (settled.has(key)) {
    throw new Error('browser_client_download_transfer_settled')
  }
  const entry = pending.get(key)
  if (!entry) {
    return null
  }
  if (
    chunk.pageHostGeneration !== entry.start.pageHostGeneration ||
    chunk.offset !== entry.received
  ) {
    settle(key, { reason: 'the download stream broke.' })
    throw new Error('browser_client_download_transfer_stale')
  }
  armIdle(key, entry)
  const bytes = Buffer.from(chunk.contentBase64, 'base64')
  entry.received += bytes.byteLength
  if (entry.received > entry.claim.maxBytes) {
    entry.tooLarge = true
    entry.chunks = []
  } else if (!entry.tooLarge) {
    entry.chunks.push(bytes)
  }
  if (!chunk.final) {
    return {}
  }
  settle(
    key,
    entry.tooLarge
      ? { reason: 'the file is too large to be what was expected.' }
      : { bytes: Buffer.concat(entry.chunks) }
  )
  return { workspaceRelativePath: entry.claim.label }
}

/** A cancelled or failed claimed download still reaches its claimant, so it can clean up. */
export function abortClaimedClientDownload(browserPageId: string, transferId: string): boolean {
  const key = keyOf(browserPageId, transferId)
  if (!pending.has(key)) {
    return settled.has(key)
  }
  settle(key, { reason: 'the download was canceled.' })
  return true
}
