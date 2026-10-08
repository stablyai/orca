import { createHash, webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  serializeStructuredAgentSessionFingerprintPayload,
  structuredAgentSessionPayloadFingerprint
} from '../../../src/shared/structured-agent-session-mutation'
import * as portableHash from '../../../src/shared/sha256'
import { mobileNativeChatImageContentFingerprint } from '../session/mobile-native-chat-image-attachment'
import { fingerprintNativeChatImage as fingerprintNativeImage } from './native-chat-image-fingerprint'
import { fingerprintNativeChatImage } from './native-chat-image-fingerprint.web'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('native chat image fingerprints', () => {
  it('preserves the existing fixed image fingerprint domain', async () => {
    const expected = createHash('sha256')
      .update('{"fields":{"base64":"AQID"},"method":"mobile.nativeChat.image","sessionId":""}')
      .digest('hex')
    vi.stubGlobal('crypto', webcrypto)

    expect(mobileNativeChatImageContentFingerprint('AQID')).toBe(expected)
    expect(await fingerprintNativeChatImage('AQID')).toBe(expected)
  })

  it('keeps the selected canonical envelope, nested ordering, undefined and Unicode', () => {
    const input = {
      method: 'm',
      sessionId: 's',
      fields: {
        z: undefined,
        nested: { z: null, a: '\ud800' },
        array: [undefined, '😀'],
        '2': 'two',
        '10': 'ten'
      },
      ignoredExtra: 'outside the envelope'
    }
    const canonical =
      '{"fields":{"10":"ten","2":"two","array":[null,"😀"],"nested":{"a":"\\ud800","z":null}},"method":"m","sessionId":"s"}'

    expect(serializeStructuredAgentSessionFingerprintPayload(input)).toBe(canonical)
    expect(
      serializeStructuredAgentSessionFingerprintPayload({
        ...input,
        fields: {
          '10': 'ten',
          '2': 'two',
          array: [undefined, '😀'],
          nested: { a: '\ud800', z: null }
        }
      })
    ).toBe(canonical)
    expect(structuredAgentSessionPayloadFingerprint(input)).toBe(
      createHash('sha256').update(canonical).digest('hex')
    )
  })

  it.each(['', 'AAAA', 'data:image/png;base64,AAAA', '\ud800', '日本語😀', 'AQID'.repeat(4096)])(
    'keeps the existing fingerprint for %j',
    async (base64) => {
      vi.stubGlobal('crypto', webcrypto)
      expect(await fingerprintNativeChatImage(base64)).toBe(
        mobileNativeChatImageContentFingerprint(base64)
      )
    }
  )

  it('uses browser crypto without running the portable hash or encoding twice', async () => {
    const base64 = 'AQID'.repeat(256 * 1024)
    const expected = mobileNativeChatImageContentFingerprint(base64)
    vi.stubGlobal('crypto', webcrypto)
    const nativeDigest = vi.spyOn(webcrypto.subtle, 'digest')
    const fallbackHash = vi.spyOn(portableHash, 'sha256')
    const encode = vi.spyOn(TextEncoder.prototype, 'encode')

    expect(await fingerprintNativeChatImage(base64)).toBe(expected)
    expect(nativeDigest).toHaveBeenCalledExactlyOnceWith('SHA-256', expect.any(Uint8Array))
    expect(fallbackHash).not.toHaveBeenCalled()
    expect(encode).toHaveBeenCalledTimes(1)
  })

  it.each(['missing', 'insecure', 'rejected', 'throwing'])(
    'keeps a successful upload fingerprint when browser crypto is %s',
    async (mode) => {
      const base64 = 'data:image/png;base64,AQID'
      const expected = mobileNativeChatImageContentFingerprint(base64)
      const digest = vi.fn(() => {
        if (mode === 'throwing') {
          throw new Error('crypto unavailable')
        }
        return Promise.reject(new Error('crypto unavailable'))
      })
      vi.stubGlobal(
        'crypto',
        mode === 'missing' ? undefined : { subtle: mode === 'insecure' ? undefined : { digest } }
      )
      const fallbackHash = vi.spyOn(portableHash, 'sha256')
      const encode = vi.spyOn(TextEncoder.prototype, 'encode')

      expect(await fingerprintNativeChatImage(base64)).toBe(expected)
      expect(fallbackHash).toHaveBeenCalledTimes(1)
      expect(encode).toHaveBeenCalledTimes(1)
    }
  )

  it('keeps the native platform function synchronous and identical', () => {
    expect(fingerprintNativeImage).toBe(mobileNativeChatImageContentFingerprint)
    expect(fingerprintNativeImage('AAAA')).toBe(mobileNativeChatImageContentFingerprint('AAAA'))
  })
})
