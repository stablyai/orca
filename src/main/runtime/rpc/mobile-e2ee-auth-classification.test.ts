import { describe, expect, it } from 'vitest'
import { classifyE2EEAuth } from './mobile-e2ee-auth-validation'
import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'

const transcriptHashB64 = Buffer.alloc(32, 3).toString('base64')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: classification reads only transcriptHashB64.
const v2 = { transcriptHashB64 } as DesktopMobileE2EEV2Session
const proof = Buffer.alloc(64, 1).toString('base64')
const auth = (fields: Record<string, unknown>) => JSON.stringify({ type: 'e2ee_auth', ...fields })

describe('classifyE2EEAuth', () => {
  it('keeps both shipped token shapes', () => {
    expect(classifyE2EEAuth(auth({ deviceToken: 't', clientCapabilities: ['x'] }), null)).toEqual({
      kind: 'token',
      deviceToken: 't',
      clientCapabilities: ['x']
    })
    expect(classifyE2EEAuth(auth({ v: 2, transcriptHashB64, deviceToken: 't' }), v2)).toEqual({
      kind: 'token',
      deviceToken: 't'
    })
  })

  it('accepts key auth only inside the matching v2 transcript', () => {
    const keyAuth = { v: 2, transcriptHashB64, deviceId: 'd', deviceProofB64: proof }
    expect(classifyE2EEAuth(auth({ ...keyAuth, clientCapabilities: ['x'] }), v2)).toMatchObject({
      kind: 'device-key',
      deviceId: 'd'
    })
    expect(classifyE2EEAuth(auth(keyAuth), null).kind).toBe('invalid')
    expect(
      classifyE2EEAuth(
        auth({ ...keyAuth, transcriptHashB64: Buffer.alloc(32).toString('base64') }),
        v2
      ).kind
    ).toBe('invalid')
  })

  it('rejects mixtures and malformed proofs', () => {
    const base = { v: 2, transcriptHashB64 }
    expect(
      classifyE2EEAuth(
        auth({ ...base, deviceId: 'd', deviceProofB64: proof, deviceToken: 't' }),
        v2
      ).kind
    ).toBe('invalid')
    expect(
      classifyE2EEAuth(auth({ ...base, deviceToken: 't', clientCapabilities: [] }), v2).kind
    ).toBe('invalid')
    expect(
      classifyE2EEAuth(auth({ ...base, deviceId: 'd', deviceProofB64: 'short' }), v2).kind
    ).toBe('invalid')
    expect(classifyE2EEAuth(auth({ deviceToken: 't', deviceId: 'd' }), null).kind).toBe('invalid')
    expect(classifyE2EEAuth('[]', null).kind).toBe('invalid')
  })
})
