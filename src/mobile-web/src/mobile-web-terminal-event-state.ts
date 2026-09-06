import { sha256 } from '@noble/hashes/sha256'
import {
  validateMobileWebTerminalOutputSequence,
  validateMobileWebTerminalSnapshotOffset,
  type MobileWebTerminalOscLinkRange,
  type MobileWebTerminalEvent
} from '../../shared/mobile-web/terminal-stream-contract'

type SnapshotState = {
  id: string
  kind: 'initial' | 'resize' | 'resync'
  viewport: { cols: number; rows: number }
  totalBytes: number
  throughSequence: number
  sha256: string
  oscLinks?: MobileWebTerminalOscLinkRange[]
  nextOffset: number
  chunks: Uint8Array[]
}

export type MobileWebTerminalEffect =
  | { type: 'none' }
  | {
      type: 'ready'
      sequence: number
      viewport: { cols: number; rows: number }
      queryReplyNegotiated: boolean
    }
  | { type: 'displayMode'; displayMode: 'auto' | 'desktop' }
  | { type: 'write'; data: Uint8Array; throughSequence: number }
  | {
      type: 'replace'
      data: Uint8Array
      throughSequence: number
      kind: 'initial' | 'resize' | 'resync'
      viewport: { cols: number; rows: number }
      oscLinks?: MobileWebTerminalOscLinkRange[]
    }
  | { type: 'resized'; viewport: { cols: number; rows: number } }
  | { type: 'resync'; fromSequence: number; reason: 'gap' | 'overflow' }
  | { type: 'closed' }
  | { type: 'error'; recoverable: boolean }

export class MobileWebTerminalEventState {
  private expectedSequence = 0
  private snapshot: SnapshotState | null = null

  constructor(private readonly streamId: string) {}

  apply(event: MobileWebTerminalEvent): MobileWebTerminalEffect {
    if (event.streamId !== this.streamId) {
      return { type: 'error', recoverable: false }
    }
    if (event.type === 'subscribed') {
      this.expectedSequence = event.startSequence
      this.snapshot = null
      return {
        type: 'ready',
        sequence: event.startSequence,
        viewport: event.viewport,
        queryReplyNegotiated: event.queryReplyNegotiated === true
      }
    }
    if (event.type === 'output') {
      return this.applyOutput(event)
    }
    if (event.type === 'snapshotStart') {
      this.snapshot = {
        id: event.snapshotId,
        kind: event.kind,
        viewport: event.viewport,
        totalBytes: event.totalBytes,
        throughSequence: event.throughSequence,
        sha256: event.sha256,
        ...(event.oscLinks ? { oscLinks: event.oscLinks } : {}),
        nextOffset: 0,
        chunks: []
      }
      return { type: 'none' }
    }
    if (event.type === 'snapshotChunk') {
      return this.applySnapshotChunk(event)
    }
    if (event.type === 'snapshotEnd') {
      return this.finishSnapshot(event)
    }
    if (event.type === 'closed') {
      return { type: 'closed' }
    }
    if (event.type === 'metadata') {
      return { type: 'displayMode', displayMode: event.displayMode }
    }
    if (event.type === 'resized') {
      return { type: 'resized', viewport: event.viewport }
    }
    if (event.type === 'error') {
      return { type: 'error', recoverable: event.recoverable }
    }
    return { type: 'none' }
  }

  private applyOutput(
    event: Extract<MobileWebTerminalEvent, { type: 'output' }>
  ): MobileWebTerminalEffect {
    const sequence = validateMobileWebTerminalOutputSequence(this.expectedSequence, event)
    if (!sequence.ok) {
      return {
        type: 'resync',
        fromSequence: this.expectedSequence,
        reason: sequence.reason === 'gap' ? 'gap' : 'overflow'
      }
    }
    const data = decodeBase64(event.data)
    this.expectedSequence = sequence.nextSequence
    return { type: 'write', data, throughSequence: sequence.nextSequence }
  }

  private applySnapshotChunk(
    event: Extract<MobileWebTerminalEvent, { type: 'snapshotChunk' }>
  ): MobileWebTerminalEffect {
    const snapshot = this.snapshot
    if (!snapshot || snapshot.id !== event.snapshotId) {
      return { type: 'resync', fromSequence: this.expectedSequence, reason: 'gap' }
    }
    const sequence = validateMobileWebTerminalSnapshotOffset(snapshot.nextOffset, event)
    if (!sequence.ok) {
      this.snapshot = null
      return { type: 'resync', fromSequence: this.expectedSequence, reason: 'gap' }
    }
    snapshot.chunks.push(decodeBase64(event.data))
    snapshot.nextOffset = sequence.nextSequence
    return { type: 'none' }
  }

  private finishSnapshot(
    event: Extract<MobileWebTerminalEvent, { type: 'snapshotEnd' }>
  ): MobileWebTerminalEffect {
    const snapshot = this.snapshot
    this.snapshot = null
    if (
      !snapshot ||
      snapshot.id !== event.snapshotId ||
      snapshot.totalBytes !== event.totalBytes ||
      snapshot.nextOffset !== event.totalBytes ||
      snapshot.throughSequence !== event.throughSequence ||
      snapshot.sha256 !== event.sha256
    ) {
      return { type: 'resync', fromSequence: this.expectedSequence, reason: 'gap' }
    }
    const data = concatenate(snapshot.chunks, snapshot.totalBytes)
    if (hex(sha256(data)) !== snapshot.sha256) {
      return { type: 'resync', fromSequence: this.expectedSequence, reason: 'gap' }
    }
    this.expectedSequence = snapshot.throughSequence
    return {
      type: 'replace',
      data,
      throughSequence: snapshot.throughSequence,
      kind: snapshot.kind,
      viewport: snapshot.viewport,
      ...(snapshot.oscLinks ? { oscLinks: snapshot.oscLinks } : {})
    }
  }
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function concatenate(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
