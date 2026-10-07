import { randomUUID } from 'node:crypto'
import {
  CHECKPOINT_CHUNK_BYTES,
  CHECKPOINT_LEASE_BYTES
} from '@xterm/addon-image/src/ImageCheckpointResources'
import type {
  TerminalModelCheckpointLease,
  TerminalModelCheckpointResourceWindow
} from '../../shared/terminal-model-checkpoint-lease'
import type { RuntimeHeadlessModelCapture } from './headless-terminal-model-checkpoint'

export const TERMINAL_MODEL_LEASE_TTL_MS = 60_000
export const TERMINAL_MODEL_LEASE_CACHE_BYTES = 256 * 1024 * 1024
const MAX_LEASES = 32

export type TerminalModelLeaseOwner = { viewerId: string; ptyId: string; incarnationId?: string }
type PendingCapture = { owner: TerminalModelLeaseOwner; canceled: boolean }
type LeaseEntry = {
  owner: TerminalModelLeaseOwner
  capture: RuntimeHeadlessModelCapture
  metadata: Uint8Array
  bytes: number
  expiresAt: number
  timeout: ReturnType<typeof setTimeout>
  onRelease?: () => void
}

function sameOwner(a: TerminalModelLeaseOwner, b: TerminalModelLeaseOwner): boolean {
  return a.viewerId === b.viewerId && a.ptyId === b.ptyId && a.incarnationId === b.incarnationId
}

export class TerminalModelCheckpointLeases {
  private readonly entries = new Map<string, LeaseEntry>()
  private readonly pending = new Set<PendingCapture>()
  private retainedBytes = 0
  private reservedBytes = 0
  private disposed = false

  constructor(private readonly maxBytes = TERMINAL_MODEL_LEASE_CACHE_BYTES) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 0 ||
      maxBytes > TERMINAL_MODEL_LEASE_CACHE_BYTES
    ) {
      throw new RangeError('Invalid terminal checkpoint cache budget')
    }
  }

  get byteSize(): number {
    return this.retainedBytes + this.reservedBytes
  }

  async capture(
    owner: TerminalModelLeaseOwner,
    load: (maxBytes: number) => Promise<RuntimeHeadlessModelCapture | null>,
    onRelease?: () => void
  ): Promise<TerminalModelCheckpointLease | null> {
    if (this.disposed || !owner.viewerId || !owner.ptyId) {
      return null
    }
    this.expire()
    const budget = Math.min(CHECKPOINT_LEASE_BYTES, Math.floor((this.maxBytes - this.byteSize) / 2))
    if (budget < 1 || this.entries.size + this.pending.size >= MAX_LEASES) {
      return null
    }
    // The metadata wire copy also lives until release; reserve before asynchronous capture.
    const reservation = budget * 2
    const pending = { owner: { ...owner }, canceled: false }
    this.pending.add(pending)
    this.reservedBytes += reservation
    let capture: RuntimeHeadlessModelCapture | null = null
    let transferred = false
    try {
      capture = await load(budget)
      if (!capture || pending.canceled || this.disposed) {
        return null
      }
      capture.checkSourceCurrent()
      const header = capture.checkpoint.metadata
      const metadata = new TextEncoder().encode(JSON.stringify(header))
      const bytes = header.byteLength + metadata.byteLength
      if (
        header.byteLength > budget ||
        metadata.byteLength > header.metadataByteLength ||
        bytes > reservation ||
        !Number.isSafeInteger(capture.outputSequence) ||
        capture.outputSequence < 0
      ) {
        throw new RangeError('Terminal checkpoint exceeds reserved budget')
      }
      const leaseId = randomUUID()
      const timeout = setTimeout(() => this.delete(leaseId), TERMINAL_MODEL_LEASE_TTL_MS)
      timeout.unref?.()
      this.entries.set(leaseId, {
        owner: pending.owner,
        capture,
        metadata,
        bytes,
        expiresAt: performance.now() + TERMINAL_MODEL_LEASE_TTL_MS,
        timeout,
        onRelease
      })
      this.retainedBytes += bytes
      transferred = true
      return {
        version: 1,
        leaseId,
        ptyId: pending.owner.ptyId,
        ...(pending.owner.incarnationId ? { incarnationId: pending.owner.incarnationId } : {}),
        sourceSeq: capture.outputSequence,
        metadataByteLength: metadata.byteLength,
        byteLength: header.byteLength
      }
    } finally {
      this.pending.delete(pending)
      this.reservedBytes -= reservation
      if (!transferred) {
        try {
          capture?.dispose()
        } finally {
          onRelease?.()
        }
      }
    }
  }

  read(owner: TerminalModelLeaseOwner, window: TerminalModelCheckpointResourceWindow): Uint8Array {
    const entry = this.entries.get(window.leaseId)
    if (!entry || !sameOwner(owner, entry.owner)) {
      throw new Error('Invalid or expired terminal checkpoint lease')
    }
    try {
      if (performance.now() >= entry.expiresAt) {
        throw new Error('Terminal checkpoint expired')
      }
      entry.capture.checkSourceCurrent()
    } catch {
      this.delete(window.leaseId)
      throw new Error('Invalid or expired terminal checkpoint lease')
    }
    if (
      !Number.isSafeInteger(window.offset) ||
      !Number.isSafeInteger(window.length) ||
      window.offset < 0 ||
      window.length < 1 ||
      window.length > CHECKPOINT_CHUNK_BYTES
    ) {
      throw new RangeError('Invalid terminal checkpoint resource window')
    }
    if (window.resourceId === null) {
      if (window.offset + window.length > entry.metadata.byteLength) {
        throw new RangeError('Invalid terminal checkpoint metadata window')
      }
      return entry.metadata.slice(window.offset, window.offset + window.length)
    }
    return entry.capture.checkpoint.readResource(window.resourceId, window.offset, window.length)
  }

  release(owner: TerminalModelLeaseOwner, leaseId: string): boolean {
    const entry = this.entries.get(leaseId)
    return Boolean(entry && sameOwner(owner, entry.owner) && this.delete(leaseId))
  }

  releaseViewer(viewerId: string): void {
    this.releaseMatching((owner) => owner.viewerId === viewerId)
  }

  releasePty(ptyId: string): void {
    this.releaseMatching((owner) => owner.ptyId === ptyId)
  }

  dispose(): void {
    this.disposed = true
    this.releaseMatching(() => true)
  }

  private releaseMatching(matches: (owner: TerminalModelLeaseOwner) => boolean): void {
    for (const pending of this.pending) {
      if (matches(pending.owner)) {
        pending.canceled = true
      }
    }
    for (const [id, entry] of this.entries) {
      if (matches(entry.owner)) {
        this.delete(id)
      }
    }
  }

  private expire(): void {
    for (const [id, entry] of this.entries) {
      if (performance.now() >= entry.expiresAt) {
        this.delete(id)
      }
    }
  }

  private delete(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) {
      return false
    }
    this.entries.delete(id)
    clearTimeout(entry.timeout)
    this.retainedBytes -= entry.bytes
    try {
      entry.capture.dispose()
    } finally {
      entry.onRelease?.()
    }
    return true
  }
}
