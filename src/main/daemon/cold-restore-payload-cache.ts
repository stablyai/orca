import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

export type ColdRestorePayload = {
  scrollback: string
  cwd: string
  cols: number
  rows: number
  oscLinks?: TerminalOscLinkRange[]
}

// Why: restore payloads remain sticky only for remount safety; cap their aggregate main-process footprint.
export const MAX_COLD_RESTORE_CACHE_BYTES = 16 * 1024 * 1024

export function getColdRestorePayloadBytes(payload: ColdRestorePayload): number {
  const oscLinkBytes =
    payload.oscLinks?.reduce((bytes, link) => bytes + link.uri.length * 2 + 24, 0) ?? 0
  // Why: code-unit sizing bounds V8 string storage without rescanning or flattening multi-MB ropes.
  return payload.scrollback.length * 2 + payload.cwd.length * 2 + oscLinkBytes + 16
}

export class ColdRestorePayloadCache {
  private entries = new Map<string, { payload: ColdRestorePayload; bytes: number }>()
  private totalBytes = 0

  constructor(
    private readonly maxBytes = MAX_COLD_RESTORE_CACHE_BYTES,
    private readonly onEvict?: (sessionId: string) => void
  ) {}

  get byteSize(): number {
    return this.totalBytes
  }

  get(sessionId: string): ColdRestorePayload | undefined {
    const entry = this.entries.get(sessionId)
    if (!entry) {
      return undefined
    }
    this.entries.delete(sessionId)
    this.entries.set(sessionId, entry)
    return entry.payload
  }

  has(sessionId: string): boolean {
    return this.entries.has(sessionId)
  }

  set(sessionId: string, payload: ColdRestorePayload): void {
    this.delete(sessionId)
    const bytes = getColdRestorePayloadBytes(payload)
    this.entries.set(sessionId, { payload, bytes })
    this.totalBytes += bytes

    while (this.totalBytes > this.maxBytes) {
      const oldestSessionId = this.entries.keys().next().value
      if (oldestSessionId === undefined) {
        break
      }
      this.delete(oldestSessionId)
      this.onEvict?.(oldestSessionId)
    }
  }

  delete(sessionId: string): boolean {
    const entry = this.entries.get(sessionId)
    if (!entry) {
      return false
    }
    this.entries.delete(sessionId)
    this.totalBytes -= entry.bytes
    return true
  }

  clear(): void {
    this.entries.clear()
    this.totalBytes = 0
  }
}
