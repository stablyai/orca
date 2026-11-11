import { describe, expect, it, vi } from 'vitest'
import { COMPRESSED_FRAMES_CLIENT_CAPABILITY } from '../../../shared/remote-runtime/e2ee/paired-e2ee-compressed-frame'
import { compressMobileE2EEV2Item } from './mobile-e2ee-v2-compressed-frame'

const capable = [COMPRESSED_FRAMES_CLIENT_CAPABILITY]

describe('compressMobileE2EEV2Item', () => {
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
