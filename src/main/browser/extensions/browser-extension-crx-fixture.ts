import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'

/** Builds real CRX3 packages in tests, signed with keys generated on the spot. */

export type CrxTestKey = { algorithm: 'rsa' | 'ecdsa'; privateKey: KeyObject; publicKeyDer: Buffer }

export function generateCrxTestKey(algorithm: CrxTestKey['algorithm']): CrxTestKey {
  const pair =
    algorithm === 'rsa'
      ? generateKeyPairSync('rsa', { modulusLength: 2048 })
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  return {
    algorithm,
    privateKey: pair.privateKey,
    publicKeyDer: pair.publicKey.export({ type: 'spki', format: 'der' })
  }
}

function varint(value: number): Buffer {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return Buffer.from(bytes)
}

export function protobufBytesField(field: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint(field * 8 + 2), varint(bytes.length), bytes])
}

function uint32le(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32LE(value)
  return buffer
}

export function buildTestCrx(options: {
  archive: Buffer
  /** Key whose hash becomes the CRX id. */
  developerKey: CrxTestKey
  signers: CrxTestKey[]
  /** Proof algorithm tag override, to test key/tag mismatches. */
  tagFor?: (key: CrxTestKey) => number
}): Buffer {
  const crxId = createHash('sha256')
    .update(options.developerKey.publicKeyDer)
    .digest()
    .subarray(0, 16)
  const signedHeaderData = protobufBytesField(1, crxId)
  const signedData = Buffer.concat([
    Buffer.from('CRX3 SignedData\x00', 'latin1'),
    uint32le(signedHeaderData.length),
    signedHeaderData,
    options.archive
  ])
  const proofs = options.signers.map((key) =>
    protobufBytesField(
      options.tagFor?.(key) ?? (key.algorithm === 'rsa' ? 2 : 3),
      Buffer.concat([
        protobufBytesField(1, key.publicKeyDer),
        protobufBytesField(2, sign('sha256', signedData, key.privateKey))
      ])
    )
  )
  const header = Buffer.concat([...proofs, protobufBytesField(10000, signedHeaderData)])
  return Buffer.concat([
    Buffer.from('Cr24', 'latin1'),
    uint32le(3),
    uint32le(header.length),
    header,
    options.archive
  ])
}
