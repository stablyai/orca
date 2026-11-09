import './mobile-relay-e2ee-link'
import './mobile-e2ee-v2-physical-channel'
import '../relay/replacement-session-authentication'

export function encodeBase64Url(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
