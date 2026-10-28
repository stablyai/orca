import { createPublicKey, verify, type KeyObject } from 'node:crypto'

const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60

// The portal shows the application's Ed25519 public key as 64 hex characters.
export function decodeDiscordPublicKey(hex: string): KeyObject {
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error('ORCA_CONNECTOR_DISCORD_PUBLIC_KEY must be 64 hex characters')
  }
  return createPublicKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(hex, 'hex').toString('base64url') },
    format: 'jwk'
  })
}

// Discord signs `<timestamp><raw body>` with Ed25519; a timestamp more than five minutes from our
// clock is refused as a replay.
export function verifyDiscordSignature(input: {
  publicKey: KeyObject
  timestamp: string | undefined
  signature: string | undefined
  rawBody: string
  nowMs: number
}): boolean {
  const { timestamp, signature } = input
  if (!timestamp || !signature || !/^\d+$/.test(timestamp) || !/^[0-9a-f]{128}$/i.test(signature)) {
    return false
  }
  if (Math.abs(input.nowMs / 1000 - Number(timestamp)) > MAX_TIMESTAMP_SKEW_SECONDS) {
    return false
  }
  return verify(
    null,
    Buffer.from(timestamp + input.rawBody),
    input.publicKey,
    Buffer.from(signature, 'hex')
  )
}
