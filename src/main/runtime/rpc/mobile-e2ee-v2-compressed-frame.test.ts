import { gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPRESSED_FRAMES_CLIENT_CAPABILITY,
  readCompressedFrame
} from '../../../shared/paired-e2ee-compressed-frame'
import { compressMobileE2EEV2Item } from './mobile-e2ee-v2-compressed-frame'

const capable = [COMPRESSED_FRAMES_CLIENT_CAPABILITY]

function inflate(item: ReturnType<typeof compressMobileE2EEV2Item>) {
  const frame = item.kind === 'binary' ? readCompressedFrame(item.plaintext) : null
  return frame && { payloadKind: frame.payloadKind, bytes: gunzipSync(frame.gzipped) }
}

describe('compressMobileE2EEV2Item', () => {
  it('sends large text to a capable phone as a compressed frame that inflates to the same text', () => {
    const plaintext = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => `ü-row-${i}`) })

    const inflated = inflate(compressMobileE2EEV2Item({ kind: 'text', plaintext }, capable))

    expect(inflated?.payloadKind).toBe('text')
    expect(inflated?.bytes.toString('utf8')).toBe(plaintext)
  })

  it('compresses binary only when its sender marks it compressible', () => {
    const terminal = { kind: 'binary' as const, plaintext: new Uint8Array(4096).fill(0x74) }

    expect(compressMobileE2EEV2Item(terminal, capable)).toBe(terminal)
    const inflated = inflate(compressMobileE2EEV2Item(terminal, capable, { compressible: true }))
    expect(inflated?.payloadKind).toBe('binary')
    expect(new Uint8Array(inflated!.bytes)).toEqual(terminal.plaintext)
  })

  it('leaves frames alone for phones without the capability and for small frames', () => {
    const large = { kind: 'text' as const, plaintext: 'x'.repeat(4096) }
    const small = { kind: 'text' as const, plaintext: '{"id":"1"}' }

    expect(compressMobileE2EEV2Item(large, [])).toBe(large)
    expect(compressMobileE2EEV2Item(small, capable)).toBe(small)
  })

  it('sends plain frames to every phone while the rollback switch is set', () => {
    const large = { kind: 'text' as const, plaintext: 'x'.repeat(4096) }
    vi.stubEnv('ORCA_DISABLE_MOBILE_COMPRESSED_FRAMES', '1')
    try {
      expect(compressMobileE2EEV2Item(large, capable)).toBe(large)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
