import { sha256 } from '@noble/hashes/sha256'
import { describe, expect, it } from 'vitest'
import { MobileWebTerminalEventState } from './mobile-web-terminal-event-state'

const STREAM_ID = 'S'.repeat(22)
const SNAPSHOT_ID = 'N'.repeat(22)
const OSC_LINKS = [{ row: 0, startCol: 0, endCol: 7, uri: 'file:///tmp/a.ts' }]

describe('MobileWebTerminalEventState', () => {
  it('verifies a snapshot before replacing output and advances ordered writes', () => {
    const state = new MobileWebTerminalEventState(STREAM_ID)
    const snapshot = new TextEncoder().encode('prompt$ ')
    const hash = hex(sha256(snapshot))
    expect(
      state.apply({
        type: 'subscribed',
        streamId: STREAM_ID,
        viewport: { cols: 80, rows: 24 },
        startSequence: 10,
        maxOutstandingBytes: 256 * 1024,
        queryReplyNegotiated: true
      })
    ).toEqual({
      type: 'ready',
      sequence: 10,
      viewport: { cols: 80, rows: 24 },
      queryReplyNegotiated: true
    })
    state.apply({
      type: 'snapshotStart',
      streamId: STREAM_ID,
      snapshotId: SNAPSHOT_ID,
      kind: 'initial',
      viewport: { cols: 80, rows: 24 },
      totalBytes: snapshot.byteLength,
      throughSequence: 10,
      sha256: hash,
      truncated: false,
      source: 'renderer',
      oscLinks: OSC_LINKS
    })
    state.apply({
      type: 'snapshotChunk',
      streamId: STREAM_ID,
      snapshotId: SNAPSHOT_ID,
      offset: 0,
      data: base64(snapshot)
    })
    expect(
      state.apply({
        type: 'snapshotEnd',
        streamId: STREAM_ID,
        snapshotId: SNAPSHOT_ID,
        totalBytes: snapshot.byteLength,
        throughSequence: 10,
        sha256: hash
      })
    ).toEqual({
      type: 'replace',
      data: snapshot,
      throughSequence: 10,
      kind: 'initial',
      viewport: { cols: 80, rows: 24 },
      oscLinks: OSC_LINKS
    })

    const output = new TextEncoder().encode('λ')
    expect(
      state.apply({
        type: 'output',
        streamId: STREAM_ID,
        startSequence: 10,
        endSequence: 10 + output.byteLength,
        data: base64(output)
      })
    ).toEqual({ type: 'write', data: output, throughSequence: 10 + output.byteLength })
  })

  it('requests resync on output gaps and corrupted snapshots', () => {
    const state = new MobileWebTerminalEventState(STREAM_ID)
    state.apply({
      type: 'subscribed',
      streamId: STREAM_ID,
      viewport: { cols: 80, rows: 24 },
      startSequence: 4,
      maxOutstandingBytes: 256 * 1024,
      queryReplyNegotiated: true
    })
    expect(
      state.apply({
        type: 'output',
        streamId: STREAM_ID,
        startSequence: 6,
        endSequence: 7,
        data: base64(new TextEncoder().encode('x'))
      })
    ).toEqual({ type: 'resync', fromSequence: 4, reason: 'gap' })
  })

  it('publishes display mode changes without exposing host metadata', () => {
    const state = new MobileWebTerminalEventState(STREAM_ID)
    expect(state.apply({ type: 'metadata', streamId: STREAM_ID, displayMode: 'desktop' })).toEqual({
      type: 'displayMode',
      displayMode: 'desktop'
    })
  })

  it('reads a shell that omits queryReplyNegotiated as no negotiated reply opcode', () => {
    const state = new MobileWebTerminalEventState(STREAM_ID)
    expect(
      state.apply({
        type: 'subscribed',
        streamId: STREAM_ID,
        viewport: { cols: 80, rows: 24 },
        startSequence: 0,
        maxOutstandingBytes: 256 * 1024
      })
    ).toEqual({
      type: 'ready',
      sequence: 0,
      viewport: { cols: 80, rows: 24 },
      queryReplyNegotiated: false
    })
  })
})

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}
