import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSecretStore } from '../shared/secret-store'
import {
  ProtectedSecretPersistence,
  type ProtectedSecretRetentionUpdate
} from './protected-secret-persistence'

const cipherState = { available: true, fails: false }
const ciphertext = (plaintext: string): string =>
  Buffer.from(`encrypted:${plaintext}`).toString('base64')

function prepare(
  secrets: ProtectedSecretPersistence,
  slot: string,
  plaintext: string
): ProtectedSecretRetentionUpdate {
  const { retentionUpdate } = secrets.encrypt(slot, plaintext)
  if (!retentionUpdate) {
    throw new Error('Expected a prepared retention update')
  }
  return retentionUpdate
}

describe('protected secret acknowledgements', () => {
  beforeEach(() => {
    cipherState.available = true
    cipherState.fails = false
    setSecretStore({
      isEncryptionAvailable: () => cipherState.available,
      encryptString: (plaintext) => {
        if (cipherState.fails) {
          throw new Error('Keyring encryption failed')
        }
        return Buffer.from(`encrypted:${plaintext}`)
      },
      decryptString: (encrypted) => encrypted.toString().slice('encrypted:'.length),
      describeProtectionGap: () => null
    })
  })

  afterEach(() => vi.restoreAllMocks())

  it.each(['remove', 'empty encryption', 'empty decryption'])(
    'does not revive a secret cleared by %s while its save was in flight',
    (clear) => {
      const secrets = new ProtectedSecretPersistence()
      const update = prepare(secrets, 'slot', 'first')
      if (clear === 'remove') {
        secrets.removeRetainedBlob('slot')
      } else if (clear === 'empty encryption') {
        secrets.encrypt('slot', '')
      } else {
        secrets.decrypt('slot', '')
      }

      secrets.commitRetentionUpdates([update])

      cipherState.available = false
      expect(secrets.encrypt('slot', 'replacement').blob).toBe('')
    }
  )

  it.each(['replacement', ''])('preserves a reloaded sealed slot after an old %j save', (value) => {
    const secrets = new ProtectedSecretPersistence()
    secrets.decrypt('slot', ciphertext('original'))
    const update = prepare(secrets, 'slot', value)
    const reloaded = ciphertext('reloaded')
    cipherState.available = false
    secrets.decrypt('slot', reloaded)

    secrets.commitRetentionUpdates([update])

    expect(secrets.isSealed('slot', reloaded)).toBe(true)
    expect(secrets.encrypt('slot', '').blob).toBe(reloaded)
    expect(secrets.hasPendingEncryption()).toBe(false)
  })

  it('preserves a successfully decrypted replacement after an older save acknowledges', () => {
    const secrets = new ProtectedSecretPersistence()
    const update = prepare(secrets, 'slot', 'first')
    const reloaded = ciphertext('reloaded')
    expect(secrets.decrypt('slot', reloaded)).toBe('reloaded')

    secrets.commitRetentionUpdates([update])

    cipherState.available = false
    expect(secrets.encrypt('slot', 'reloaded').blob).toBe(reloaded)
  })

  it.each(['unavailable', 'throws'])(
    'keeps a newer %s encryption pending after an old ack',
    (failure) => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const secrets = new ProtectedSecretPersistence()
      const original = ciphertext('original')
      secrets.decrypt('slot', original)
      const update = prepare(secrets, 'slot', 'first')
      cipherState.available = failure !== 'unavailable'
      cipherState.fails = failure === 'throws'
      expect(secrets.encrypt('slot', 'newer')).toEqual({ blob: original, degraded: true })

      secrets.commitRetentionUpdates([update])

      expect(secrets.hasPendingEncryption()).toBe(true)
      cipherState.available = false
      expect(secrets.encrypt('slot', 'newer').blob).toBe(original)
      cipherState.available = true
      cipherState.fails = false
      const retry = prepare(secrets, 'slot', 'newer')
      secrets.commitRetentionUpdates([retry])
      expect(secrets.hasPendingEncryption()).toBe(false)
      cipherState.available = false
      expect(secrets.encrypt('slot', 'newer').blob).toBe(ciphertext('newer'))
    }
  )

  it.each([false, true])(
    'retains only the latest prepared ciphertext, reverse ack order: %s',
    (reverse) => {
      const secrets = new ProtectedSecretPersistence()
      const older = prepare(secrets, 'slot', 'older')
      const newer = prepare(secrets, 'slot', 'newer')
      for (const update of reverse ? [newer, older] : [older, newer]) {
        secrets.commitRetentionUpdates([update])
      }

      cipherState.available = false
      expect(secrets.encrypt('slot', 'replacement').blob).toBe(ciphertext('newer'))
    }
  )

  it('retains the last same-slot value in a single acknowledged preparation batch', () => {
    const secrets = new ProtectedSecretPersistence()
    const updates = [prepare(secrets, 'slot', 'older'), prepare(secrets, 'slot', 'newer')]

    secrets.commitRetentionUpdates(updates)

    cipherState.available = false
    expect(secrets.encrypt('slot', 'replacement').blob).toBe(ciphertext('newer'))
  })

  it('does not reuse an old acknowledgement when a removed dynamic slot is recreated', () => {
    const secrets = new ProtectedSecretPersistence()
    const removed = prepare(secrets, 'dynamic-slot', 'removed')
    secrets.removeRetainedBlob('dynamic-slot')
    const recreated = prepare(secrets, 'dynamic-slot', 'recreated')

    secrets.commitRetentionUpdates([removed, recreated, removed])

    cipherState.available = false
    expect(secrets.encrypt('dynamic-slot', 'replacement').blob).toBe(ciphertext('recreated'))
  })

  it('invalidates only the changed slot in an acknowledged batch', () => {
    const secrets = new ProtectedSecretPersistence()
    const updates = [prepare(secrets, 'keep', 'keep'), prepare(secrets, 'remove', 'remove')]
    secrets.removeRetainedBlob('remove')

    secrets.commitRetentionUpdates(updates)

    cipherState.available = false
    expect(secrets.encrypt('keep', 'replacement').blob).toBe(ciphertext('keep'))
    expect(secrets.encrypt('remove', 'replacement').blob).toBe('')
  })

  it('does not accept a prepared update from a replaced persistence instance', () => {
    const previous = new ProtectedSecretPersistence()
    const current = new ProtectedSecretPersistence()
    const older = prepare(previous, 'slot', 'older')
    const newer = prepare(current, 'slot', 'newer')

    current.commitRetentionUpdates([older, newer])

    cipherState.available = false
    expect(current.encrypt('slot', 'replacement').blob).toBe(ciphertext('newer'))
  })

  it('keeps the previous ciphertext and pending retry when a prepared save has no confirmed ack', () => {
    const secrets = new ProtectedSecretPersistence()
    const original = ciphertext('original')
    secrets.decrypt('slot', original)
    cipherState.available = false
    secrets.encrypt('slot', 'replacement')
    cipherState.available = true

    prepare(secrets, 'slot', 'replacement')

    expect(secrets.hasPendingEncryption()).toBe(true)
    cipherState.available = false
    expect(secrets.encrypt('slot', 'replacement').blob).toBe(original)
  })
})
