import { createHash } from 'node:crypto'

import nacl from 'tweetnacl'
import { describe, expect, it } from 'vitest'

import { parseSshRelayManifestAcceptedKeyDocument } from './ssh-relay-manifest-accepted-keys'
import { sshRelayManifestKeyId } from './ssh-relay-manifest-signature'

const first = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index))
const second = nacl.sign.keyPair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => 31 - index))

function record(publicKey: Uint8Array) {
  return {
    keyId: sshRelayManifestKeyId(publicKey),
    publicKeyBase64: Buffer.from(publicKey).toString('base64')
  }
}

function document(keys = [record(first.publicKey)]) {
  return { schemaVersion: 1, keys }
}

describe('SSH relay manifest accepted keys', () => {
  it('parses, clones, sorts, freezes, and fingerprints the canonical release document', () => {
    const input = document([record(second.publicKey), record(first.publicKey)])
    const parsed = parseSshRelayManifestAcceptedKeyDocument(input)
    const sortedRecords = [...input.keys].sort((left, right) =>
      left.keyId < right.keyId ? -1 : left.keyId > right.keyId ? 1 : 0
    )
    const canonicalBytes = Buffer.from(
      JSON.stringify({ schemaVersion: 1, keys: sortedRecords }),
      'utf8'
    )

    expect(parsed.acceptedKeys.map(({ keyId }) => keyId)).toEqual(
      sortedRecords.map(({ keyId }) => keyId)
    )
    expect(parsed.acceptedKeys[0].publicKey).not.toBe(first.publicKey)
    expect(parsed.sha256).toBe(
      `sha256:${createHash('sha256').update(canonicalBytes).digest('hex')}`
    )
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.acceptedKeys)).toBe(true)
    expect(parsed.acceptedKeys.every(Object.isFrozen)).toBe(true)
  })

  it('accepts one to four unique keys independent of input order', () => {
    const records = [record(first.publicKey), record(second.publicKey)]
    const forward = parseSshRelayManifestAcceptedKeyDocument(document(records))
    const reverse = parseSshRelayManifestAcceptedKeyDocument(document(records.toReversed()))

    expect(forward.sha256).toBe(reverse.sha256)
    expect(forward.acceptedKeys.map(({ keyId }) => keyId)).toEqual(
      reverse.acceptedKeys.map(({ keyId }) => keyId)
    )
  })

  it('rejects malformed document shape and key counts', () => {
    for (const input of [
      null,
      [],
      {},
      { schemaVersion: 2, keys: [record(first.publicKey)] },
      { schemaVersion: 1, keys: [], extra: true },
      { schemaVersion: 1, keys: [] },
      { schemaVersion: 1, keys: Array.from({ length: 5 }, () => record(first.publicKey)) }
    ]) {
      expect(() => parseSshRelayManifestAcceptedKeyDocument(input)).toThrow(/accepted|key|field/i)
    }
  })

  it('rejects extra fields, non-canonical base64, wrong sizes, identity drift, and duplicates', () => {
    const valid = record(first.publicKey)
    for (const key of [
      { ...valid, extra: true },
      { ...valid, publicKeyBase64: `${valid.publicKeyBase64}\n` },
      { ...valid, publicKeyBase64: Buffer.alloc(31).toString('base64') },
      { ...valid, keyId: `sha256:${'0'.repeat(64)}` }
    ]) {
      expect(() =>
        parseSshRelayManifestAcceptedKeyDocument({ schemaVersion: 1, keys: [key] })
      ).toThrow(/accepted|key|base64|field|32/i)
    }
    expect(() =>
      parseSshRelayManifestAcceptedKeyDocument(document([valid, structuredClone(valid)]))
    ).toThrow(/duplicate/i)
  })
})
