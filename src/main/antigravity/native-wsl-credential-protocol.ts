import { TextDecoder } from 'node:util'
const MAX_CREDENTIAL_BYTES = 64 * 1024
export const MAX_WSL_CREDENTIAL_TRANSPORT_BYTES = 192 * 1024
function decodeBytes(value: string): string {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('Invalid WSL credential protocol')
  }
  const bytes = Buffer.from(value, 'base64')
  if (
    bytes.length === 0 ||
    bytes.length > MAX_CREDENTIAL_BYTES ||
    bytes.toString('base64') !== value
  ) {
    throw new Error('Invalid WSL credential protocol')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new Error('Invalid WSL credential protocol')
  }
}
function encodeBytes(value: string): string {
  const bytes = Buffer.from(value, 'utf8')
  if (bytes.length === 0 || bytes.length > MAX_CREDENTIAL_BYTES) {
    throw new Error('Invalid WSL credential size')
  }
  return bytes.toString('base64')
}
export function encodeAntigravityWslWrite(contents: string, expected: string | null): string {
  const input = `ORCA_AGY_WSL_INPUT_V1\n${expected === null ? 'missing' : encodeBytes(expected)}\n${encodeBytes(contents)}\n`
  if (Buffer.byteLength(input) > MAX_WSL_CREDENTIAL_TRANSPORT_BYTES) {
    throw new Error('Invalid WSL credential input size')
  }
  return input
}
export type AntigravityWslCredentialReply =
  | { status: 'missing' }
  | { status: 'present' | 'written'; contents: string }
export function decodeAntigravityWslReply(
  output: string,
  nonce: string
): AntigravityWslCredentialReply {
  const lines = output.split('\n')
  if (
    Buffer.byteLength(output) > MAX_WSL_CREDENTIAL_TRANSPORT_BYTES ||
    !/^[a-z0-9]{1,64}$/.test(nonce) ||
    lines.length !== 4 ||
    lines[0] !== `ORCA_AGY_WSL_REPLY_V1 ${nonce}` ||
    lines[3] !== ''
  ) {
    throw new Error('Invalid WSL credential protocol')
  }
  if (lines[1] === 'missing' && lines[2] === '') {
    return { status: 'missing' }
  }
  if (lines[1] !== 'present' && lines[1] !== 'written') {
    throw new Error('Invalid WSL credential protocol')
  }
  return { status: lines[1], contents: decodeBytes(lines[2]) }
}
