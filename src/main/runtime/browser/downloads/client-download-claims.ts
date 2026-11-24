// A paired desktop's download that a feature claims when it begins (the desktop says which page and
// document started it). Claimed bytes stay in this host's memory and go only to that feature, never
// to the workspace; anything unclaimed takes the ordinary workspace path, untouched.

export type ClientDownloadStart = {
  browserPageId: string
  workspaceId: string
  pageHostGeneration: number
  filename: string
  documentUrl: string
  /** An agent's `download` on the page asked for it (the desktop marks it). */
  agentDownload?: boolean
}

export type ClientDownloadClaim = {
  maxBytes: number
  /** Shown on the desktop as where the download went. */
  label: string
  /** Receives the whole download, or why it never arrived; called exactly once. */
  take(download: { bytes: Buffer } | { reason: string }): Promise<void>
  /** The final write is acknowledged only once `take` finishes, and fails the download if it throws. */
  confirmsTake?: boolean
}

export type ClientDownloadClaimant = (start: ClientDownloadStart) => ClientDownloadClaim | null

type Pending = {
  start: ClientDownloadStart
  claim: ClientDownloadClaim
  chunks: Buffer[]
  received: number
  tooLarge: boolean
  onSettled: () => void
}

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

type NextPageClaim = { claim: ClientDownloadClaim; began: () => void }
// An agent's `download --path`: the page's next download, before any other claimant sees it.
const nextByPage = new Map<string, NextPageClaim>()

/** null while another download already waits on this page. `release` drops it only if it never began. */
export function claimNextClientDownload(
  browserPageId: string,
  claim: ClientDownloadClaim
): { began: Promise<void>; release(): void } | null {
  if (nextByPage.has(browserPageId)) {
    return null
  }
  const began = Promise.withResolvers<void>()
  const entry = { claim, began: began.resolve }
  nextByPage.set(browserPageId, entry)
  return {
    began: began.promise,
    release: () => {
      if (nextByPage.get(browserPageId) === entry) {
        nextByPage.delete(browserPageId)
      }
    }
  }
}

const keyOf = (browserPageId: string, transferId: string): string =>
  `${browserPageId}\0${transferId}`

function settle(key: string, download: { bytes: Buffer } | { reason: string }): Promise<void> {
  const entry = pending.get(key)
  if (!entry) {
    return Promise.resolve()
  }
  pending.delete(key)
  entry.onSettled()
  settled.add(key)
  if (settled.size > MAX_SETTLED) {
    const [oldest] = settled
    settled.delete(oldest)
  }
  const taken = entry.claim.take(download)
  taken.catch((error: unknown) => {
    console.warn('[browser-downloads] a claimed download could not be handed over', error)
  })
  return taken
}

/** Resolves whether a claimant took the download as it began; `onSettled` runs once it is handed
 *  over or dropped, so the caller can stop watching the desktop's connection. */
export function beginClientDownload(
  transferId: string,
  start: ClientDownloadStart,
  onSettled: () => void = () => {}
): boolean {
  const next = start.agentDownload ? nextByPage.get(start.browserPageId) : undefined
  if (next) {
    nextByPage.delete(start.browserPageId)
    next.began()
  }
  const claim = next?.claim ?? claimant?.(start) ?? null
  if (!claim) {
    return false
  }
  if (pending.size >= MAX_PENDING) {
    const [oldest] = pending.keys()
    void settle(oldest, { reason: 'the download was dropped while too many were waiting.' })
  }
  pending.set(keyOf(start.browserPageId, transferId), {
    start,
    claim,
    chunks: [],
    received: 0,
    tooLarge: false,
    onSettled
  })
  return true
}

/** null when the transfer wasn't claimed; otherwise the write's acknowledgement. */
export async function writeClaimedClientDownload(chunk: {
  browserPageId: string
  transferId: string
  pageHostGeneration: number
  contentBase64: string
  offset: number
  final: boolean
}): Promise<{ workspaceRelativePath?: string } | null> {
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
    void settle(key, { reason: 'the download stream broke.' })
    throw new Error('browser_client_download_transfer_stale')
  }
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
  const taken = settle(
    key,
    entry.tooLarge
      ? { reason: 'the file is too large to be what was expected.' }
      : { bytes: Buffer.concat(entry.chunks) }
  )
  if (entry.claim.confirmsTake) {
    await taken
  }
  return { workspaceRelativePath: entry.claim.label }
}

/** A cancelled, failed or disconnected claimed download still reaches its claimant, so it can
 *  clean up and say why. */
export function abortClaimedClientDownload(
  browserPageId: string,
  transferId: string,
  reason = 'the download was canceled.'
): boolean {
  const key = keyOf(browserPageId, transferId)
  if (!pending.has(key)) {
    return settled.has(key)
  }
  void settle(key, { reason })
  return true
}
