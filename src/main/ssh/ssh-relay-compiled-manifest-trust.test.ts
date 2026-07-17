import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'

import electronViteConfig from '../../../electron.vite.config'
import {
  loadSshRelayCompiledManifestTrust,
  parseSshRelayCompiledManifestTrust
} from './ssh-relay-compiled-manifest-trust'
import { sshRelayManifestKeyId } from './ssh-relay-manifest-signature'

const keyPair = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))

function acceptedKeyDocument() {
  return {
    schemaVersion: 1,
    keys: [
      {
        keyId: sshRelayManifestKeyId(keyPair.publicKey),
        publicKeyBase64: Buffer.from(keyPair.publicKey).toString('base64')
      }
    ]
  }
}

describe('SSH relay compiled manifest trust', () => {
  it('keeps unprovisioned builds unavailable without a runtime environment fallback', () => {
    const original = process.env.ORCA_SSH_RELAY_MANIFEST_ACCEPTED_KEYS
    process.env.ORCA_SSH_RELAY_MANIFEST_ACCEPTED_KEYS = JSON.stringify(acceptedKeyDocument())
    try {
      expect(loadSshRelayCompiledManifestTrust()).toBeNull()
      expect(parseSshRelayCompiledManifestTrust(null)).toBeNull()
    } finally {
      if (original === undefined) {
        delete process.env.ORCA_SSH_RELAY_MANIFEST_ACCEPTED_KEYS
      } else {
        process.env.ORCA_SSH_RELAY_MANIFEST_ACCEPTED_KEYS = original
      }
    }
    const config = electronViteConfig as {
      main?: { define?: Record<string, string> }
    }
    expect(config.main?.define?.ORCA_SSH_RELAY_MANIFEST_ACCEPTED_KEYS).toBe('null')
  })

  it('parses a build-injected accepted-key document into immutable trust state', () => {
    const document = acceptedKeyDocument()
    const trust = parseSshRelayCompiledManifestTrust(document)

    expect(trust).not.toBeNull()
    expect(trust?.acceptedKeys).toHaveLength(1)
    expect(trust?.acceptedKeys[0].keyId).toBe(document.keys[0].keyId)
    expect(trust?.acceptedKeys[0].publicKey).not.toBe(keyPair.publicKey)
    expect(trust?.acceptedKeysSha256).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(Object.isFrozen(trust)).toBe(true)
    expect(Object.isFrozen(trust?.acceptedKeys)).toBe(true)
  })

  it('fails closed for malformed injected trust state', () => {
    expect(() => parseSshRelayCompiledManifestTrust({ schemaVersion: 1, keys: [] })).toThrow(
      /accepted|key/i
    )
  })
})
