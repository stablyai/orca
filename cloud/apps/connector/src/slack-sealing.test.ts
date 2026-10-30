import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { appSecretAad } from './slack-apps.js'
import { openSecret, sealSecret } from './slack-sealing.js'

describe('secret sealing', () => {
  it('opens only with the same key and AAD', () => {
    const key = randomBytes(32)
    const sealed = sealSecret(key, 'T1', 'xoxb-secret')
    expect(sealed).not.toContain('xoxb')
    expect(openSecret(key, 'T1', sealed)).toBe('xoxb-secret')
    expect(() => openSecret(key, 'T2', sealed)).toThrow()
    expect(() => openSecret(randomBytes(32), 'T1', sealed)).toThrow()
  })

  it('keeps an app’s two secrets, other apps and bot tokens apart', () => {
    const key = randomBytes(32)
    const sealed = sealSecret(key, appSecretAad('signing', 'A1'), 's')
    expect(openSecret(key, appSecretAad('signing', 'A1'), sealed)).toBe('s')
    for (const aad of [appSecretAad('client', 'A1'), appSecretAad('signing', 'A2'), 'A1']) {
      expect(() => openSecret(key, aad, sealed)).toThrow()
    }
  })
})
