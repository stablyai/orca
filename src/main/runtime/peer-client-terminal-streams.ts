import WebSocket from 'ws'
import { decryptBytes, encryptBytes } from '../../shared/e2ee-crypto'
import type { PairingOffer } from '../../shared/pairing'
import type { PeerTerminalStreamEvent } from '../../shared/peer-terminal-stream-event'
import {
  TerminalStreamOpcode,
  decodeTerminalStreamFrame,
  decodeTerminalStreamJson,
  decodeTerminalStreamText,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText,
  type TerminalStreamFrame
} from '../../shared/terminal-stream-protocol'
import type { PeerClientRpcChannel } from './peer-client-rpc-channel'

type PeerTerminalStreamEntry = {
  terminal: string
  onEvent: (event: PeerTerminalStreamEvent) => void
  streamId: number | null
  snapshotMeta: Record<string, unknown> | null
  snapshotChunks: string[]
  outboundSeq: number
}

export type PeerClientTerminalStreamsDeps = {
  rpc: PeerClientRpcChannel
  getOffer: () => PairingOffer | null
  getHandshakeState: () => 'awaiting_ready' | 'awaiting_auth' | 'ready'
  getClientId: () => string | null
  getWs: () => WebSocket | null
  getSharedKey: () => Uint8Array | null
  nextCounter: () => number
}

// Why: owns terminal.subscribe's requestId/streamId bookkeeping and the
// binary terminal-stream-protocol framing so PeerClientService only sees
// PeerTerminalStreamEvent callbacks.
export class PeerClientTerminalStreams {
  private readonly byRequestId = new Map<string, PeerTerminalStreamEntry>()
  private readonly byStreamId = new Map<number, PeerTerminalStreamEntry>()

  constructor(private readonly deps: PeerClientTerminalStreamsDeps) {}

  // Why: subscribeTerminal keys everything by the caller's own requestId so the
  // IPC boundary never has to learn the host-assigned binary streamId.
  subscribe(
    terminal: string,
    viewport: { cols: number; rows: number },
    onEvent: (event: PeerTerminalStreamEvent) => void
  ): { ok: true; requestId: string } | { ok: false; reason: string } {
    const offer = this.deps.getOffer()
    const clientId = this.deps.getClientId()
    if (!offer || this.deps.getHandshakeState() !== 'ready' || !clientId) {
      return { ok: false, reason: 'not_connected_to_a_peer_host' }
    }
    const id = `peer-term-${this.deps.nextCounter()}-${Date.now()}`
    const entry: PeerTerminalStreamEntry = {
      terminal,
      onEvent,
      streamId: null,
      snapshotMeta: null,
      snapshotChunks: [],
      outboundSeq: 0
    }
    const sent = this.deps.rpc.sendEncrypted({
      id,
      deviceToken: offer.deviceToken,
      method: 'terminal.subscribe',
      params: {
        terminal,
        client: { id: clientId, type: 'desktop' },
        viewport,
        capabilities: { terminalBinaryStream: 1 }
      }
    })
    if (!sent) {
      return { ok: false, reason: 'connection_interrupted' }
    }
    this.byRequestId.set(id, entry)
    return { ok: true, requestId: id }
  }

  unsubscribe(requestId: string): void {
    const entry = this.byRequestId.get(requestId)
    if (!entry) {
      return
    }
    this.byRequestId.delete(requestId)
    if (entry.streamId !== null) {
      this.byStreamId.delete(entry.streamId)
    }
    // Why: the host keys the subscription by `${terminal}:${clientId}`, shared
    // by every overlapping subscribe from this client (StrictMode remounts).
    // Sending terminal.unsubscribe while a sibling entry is still live would
    // tear down the sibling's stream too, so only the last one tells the host.
    for (const other of this.byRequestId.values()) {
      if (other.terminal === entry.terminal) {
        return
      }
    }
    const clientId = this.deps.getClientId()
    if (clientId) {
      void this.deps.rpc.sendRequest('terminal.unsubscribe', {
        subscriptionId: `${entry.terminal}:${clientId}`,
        client: { id: clientId }
      })
    }
  }

  sendInput(requestId: string, data: string): boolean {
    const entry = this.byRequestId.get(requestId)
    if (!entry || entry.streamId === null) {
      return false
    }
    return this.sendFrame(entry, TerminalStreamOpcode.Input, encodeTerminalStreamText(data))
  }

  resize(requestId: string, cols: number, rows: number): boolean {
    const entry = this.byRequestId.get(requestId)
    if (!entry || entry.streamId === null) {
      return false
    }
    return this.sendFrame(
      entry,
      TerminalStreamOpcode.Resize,
      encodeTerminalStreamJson({ cols, rows })
    )
  }

  private sendFrame(
    entry: PeerTerminalStreamEntry,
    opcode: TerminalStreamOpcode,
    payload: Uint8Array
  ): boolean {
    const ws = this.deps.getWs()
    const sharedKey = this.deps.getSharedKey()
    if (entry.streamId === null || !ws || ws.readyState !== WebSocket.OPEN || !sharedKey) {
      return false
    }
    const bytes = encodeTerminalStreamFrame({
      opcode,
      streamId: entry.streamId,
      seq: entry.outboundSeq++,
      payload
    })
    ws.send(Buffer.from(encryptBytes(bytes, sharedKey)), { binary: true })
    return true
  }

  endAll(): void {
    for (const entry of this.byRequestId.values()) {
      entry.onEvent({ type: 'end' })
    }
    this.byRequestId.clear()
    this.byStreamId.clear()
  }

  handleBinaryMessage(raw: Buffer): void {
    const sharedKey = this.deps.getSharedKey()
    if (!sharedKey) {
      return
    }
    const plaintext = decryptBytes(new Uint8Array(raw), sharedKey)
    if (!plaintext) {
      return
    }
    const frame = decodeTerminalStreamFrame(plaintext)
    if (!frame) {
      return
    }
    const entry = this.byStreamId.get(frame.streamId)
    if (!entry) {
      return
    }
    dispatchTerminalFrame(entry, frame)
  }

  // Why: terminal.subscribe is a streaming RPC — the host replies with several
  // `{id, ok, result, streaming:true}` envelopes over time instead of one.
  // Returns whether `id` belonged to a tracked subscribe request.
  tryHandle(id: string, message: Record<string, unknown>): boolean {
    const entry = this.byRequestId.get(id)
    if (!entry) {
      return false
    }
    if (!message.ok) {
      const error = message.error as { message?: string } | undefined
      entry.onEvent({ type: 'error', message: error?.message ?? 'subscribe_failed' })
      this.byRequestId.delete(id)
      return true
    }
    const result = message.result as Record<string, unknown> | null
    if (!result || typeof result !== 'object') {
      return true
    }
    if (result.type === 'subscribed') {
      if (typeof result.streamId === 'number') {
        entry.streamId = result.streamId
        this.byStreamId.set(result.streamId, entry)
      }
      entry.onEvent({ type: 'subscribed' })
      if (result.streamId === null) {
        // Why: no live PTY for this handle — the host emits `end` right after; nothing to stream.
        this.byRequestId.delete(id)
      }
      return true
    }
    if (result.type === 'end') {
      entry.onEvent({ type: 'end' })
      this.byRequestId.delete(id)
      if (entry.streamId !== null) {
        this.byStreamId.delete(entry.streamId)
      }
    }
    return true
  }
}

function dispatchTerminalFrame(entry: PeerTerminalStreamEntry, frame: TerminalStreamFrame): void {
  switch (frame.opcode) {
    case TerminalStreamOpcode.Output: {
      entry.onEvent({ type: 'output', data: decodeTerminalStreamText(frame.payload) })
      return
    }
    case TerminalStreamOpcode.SnapshotStart: {
      const meta = decodeTerminalStreamJson<Record<string, unknown>>(frame.payload)
      if (!meta) {
        return
      }
      entry.snapshotMeta = meta
      entry.snapshotChunks = []
      return
    }
    case TerminalStreamOpcode.SnapshotChunk: {
      if (!entry.snapshotMeta) {
        return
      }
      entry.snapshotChunks.push(decodeTerminalStreamText(frame.payload))
      return
    }
    case TerminalStreamOpcode.SnapshotEnd: {
      const meta = entry.snapshotMeta
      if (!meta) {
        return
      }
      entry.snapshotMeta = null
      const data = entry.snapshotChunks.join('')
      entry.snapshotChunks = []
      const kind = meta.kind === 'resized' ? 'resized' : 'scrollback'
      entry.onEvent({
        type: 'snapshot',
        kind,
        cols: typeof meta.cols === 'number' ? meta.cols : 80,
        rows: typeof meta.rows === 'number' ? meta.rows : 24,
        data
      })
      return
    }
    case TerminalStreamOpcode.Resized: {
      const meta = decodeTerminalStreamJson<{ cols?: unknown; rows?: unknown }>(frame.payload)
      if (!meta || typeof meta.cols !== 'number' || typeof meta.rows !== 'number') {
        return
      }
      entry.onEvent({ type: 'resized', cols: meta.cols, rows: meta.rows })
      return
    }
    case TerminalStreamOpcode.Metadata: {
      const meta = decodeTerminalStreamJson<{ cwd?: unknown }>(frame.payload)
      if (!meta) {
        return
      }
      entry.onEvent({ type: 'metadata', cwd: typeof meta.cwd === 'string' ? meta.cwd : null })
      return
    }
    case TerminalStreamOpcode.Error: {
      entry.onEvent({ type: 'error', message: decodeTerminalStreamText(frame.payload) })
    }
  }
}
