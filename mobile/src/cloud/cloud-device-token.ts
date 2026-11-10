import nacl from 'tweetnacl'
import { encodeBase64Bytes } from '../transport/encryption/base64-byte-codec'

/** Must match cloud/apps/sandbox-control/src/device-sessions.ts. */
export const CLOUD_DEVICE_TOKEN_ISSUER = 'orca-device'
export const CLOUD_DEVICE_TOKEN_AUDIENCE = 'orca-sandbox'
const TOKEN_TTL_SECONDS = 120

function base64Url(bytes: Uint8Array): string {
  return encodeBase64Bytes(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

/** A compact EdDSA JWT the control plane verifies against this device's enrolled public key. */
export function signCloudDeviceToken(args: {
  deviceSessionId: string
  secretKey: Uint8Array
  nowMs: number
  nonce: Uint8Array
}): string {
  const iat = Math.floor(args.nowMs / 1000)
  const header = base64Url(
    utf8(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: args.deviceSessionId }))
  )
  const payload = base64Url(
    utf8(
      JSON.stringify({
        iss: CLOUD_DEVICE_TOKEN_ISSUER,
        sub: args.deviceSessionId,
        aud: CLOUD_DEVICE_TOKEN_AUDIENCE,
        iat,
        exp: iat + TOKEN_TTL_SECONDS,
        jti: base64Url(args.nonce)
      })
    )
  )
  const signingInput = `${header}.${payload}`
  const signature = nacl.sign.detached(utf8(signingInput), new Uint8Array(args.secretKey))
  return `${signingInput}.${base64Url(signature)}`
}
