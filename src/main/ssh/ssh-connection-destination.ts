import { createHash } from 'node:crypto'

/** The execution host a successful ssh2 handshake proved: endpoint, accepted key and proxy route. */
export type SshConnectionDestination = Readonly<{
  version: 1
  transport: 'ssh2'
  host: string
  port: number
  username: string
  hostKeyFingerprint: string
  proxyRouteDigest: string
}>

/** Digest of the resolved proxy route; a changed ProxyCommand/ProxyJump names a different path. */
export function sshProxyRouteDigest(effectiveProxy: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(effectiveProxy ?? null))
    .digest('hex')
}

function isValidText(text: unknown): text is string {
  return (
    typeof text === 'string' &&
    text.length > 0 &&
    text.length <= 8192 &&
    !Array.from(text).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
}

function isCanonicalSha256Fingerprint(value: unknown): value is string {
  if (typeof value !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) {
    return false
  }
  const encoded = value.slice(7)
  // Why: a non-canonical trailing digit decodes to the same bytes but names a different string.
  return (
    Buffer.from(encoded, 'base64').toString('base64url') ===
    encoded.replace(/\+/g, '-').replace(/\//g, '_')
  )
}

export function parseSshConnectionDestination(value: unknown): SshConnectionDestination {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('ssh_connection_destination_invalid')
  }
  const record: Record<string, unknown> = { ...value }
  const { host, port, username, hostKeyFingerprint, proxyRouteDigest } = record
  if (
    record.version !== 1 ||
    record.transport !== 'ssh2' ||
    !isValidText(host) ||
    typeof port !== 'number' ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !isValidText(username) ||
    !isCanonicalSha256Fingerprint(hostKeyFingerprint) ||
    typeof proxyRouteDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proxyRouteDigest)
  ) {
    throw new Error('ssh_connection_destination_invalid')
  }
  return Object.freeze({
    version: 1,
    transport: 'ssh2',
    host,
    port,
    username,
    hostKeyFingerprint,
    proxyRouteDigest
  })
}
