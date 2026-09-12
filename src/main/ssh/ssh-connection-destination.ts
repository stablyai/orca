export type SshConnectionDestination = Readonly<{
  version: 1
  transport: 'ssh2'
  host: string
  port: number
  username: string
  hostKeyFingerprint: string
  proxyRouteDigest: string
}>

export function parseSshConnectionDestination(value: unknown): SshConnectionDestination {
  const record = value as SshConnectionDestination | null
  const validText = (text: unknown): text is string =>
    typeof text === 'string' &&
    text.length > 0 &&
    text.length <= 8192 &&
    !Array.from(text).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  if (
    !record ||
    Array.isArray(record) ||
    record.version !== 1 ||
    record.transport !== 'ssh2' ||
    !validText(record.host) ||
    !Number.isSafeInteger(record.port) ||
    record.port < 1 ||
    record.port > 65535 ||
    !validText(record.username) ||
    typeof record.hostKeyFingerprint !== 'string' ||
    !/^SHA256:[A-Za-z0-9+/]{43}$/.test(record.hostKeyFingerprint) ||
    Buffer.from(record.hostKeyFingerprint.slice(7), 'base64').toString('base64url') !==
      record.hostKeyFingerprint.slice(7).replace(/\+/g, '-').replace(/\//g, '_') ||
    typeof record.proxyRouteDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.proxyRouteDigest)
  ) {
    throw new Error('ssh_connection_destination_invalid')
  }
  return Object.freeze({
    version: 1,
    transport: 'ssh2',
    host: record.host,
    port: record.port,
    username: record.username,
    hostKeyFingerprint: record.hostKeyFingerprint,
    proxyRouteDigest: record.proxyRouteDigest
  })
}
