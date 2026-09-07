const OPENSSH_PRIVATE_KEY_HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----'
const OPENSSH_PRIVATE_KEY_FOOTER = '-----END OPENSSH PRIVATE KEY-----'
const OPENSSH_KEY_MAGIC = Buffer.from('openssh-key-v1\0', 'ascii')
export const MAX_SSH_IDENTITY_FILE_BYTES = 1024 * 1024
const MAX_PUBLIC_KEYS = 64
const SECURITY_KEY_TYPES = new Set([
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com'
])

type SshString = { value: Buffer; nextOffset: number }

function decodeBase64(value: string): Buffer | null {
  if (!value || value.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    return null
  }
  const unpadded = value.replace(/=+$/, '')
  const decoded = Buffer.from(unpadded, 'base64')
  return decoded.toString('base64').replace(/=+$/, '') === unpadded ? decoded : null
}

function readSshString(buffer: Buffer, offset: number): SshString | null {
  if (offset < 0 || offset + 4 > buffer.length) {
    return null
  }
  const length = buffer.readUInt32BE(offset)
  const start = offset + 4
  const end = start + length
  if (end < start || end > buffer.length) {
    return null
  }
  return { value: buffer.subarray(start, end), nextOffset: end }
}

function decodeOpenSshPrivateKey(contents: Buffer): Buffer | null {
  if (contents.length > MAX_SSH_IDENTITY_FILE_BYTES) {
    return null
  }
  const lines = contents.toString('ascii').trim().split(/\r?\n/)
  if (lines[0] !== OPENSSH_PRIVATE_KEY_HEADER || lines.at(-1) !== OPENSSH_PRIVATE_KEY_FOOTER) {
    return null
  }
  const encoded = lines.slice(1, -1).join('')
  const decoded = decodeBase64(encoded)
  if (!decoded) {
    return null
  }
  return decoded.subarray(0, OPENSSH_KEY_MAGIC.length).equals(OPENSSH_KEY_MAGIC) ? decoded : null
}

export function isOpenSshSecurityKeyPrivateKey(contents: Buffer): boolean {
  const decoded = decodeOpenSshPrivateKey(contents)
  if (!decoded) {
    return false
  }

  let offset = OPENSSH_KEY_MAGIC.length
  for (let field = 0; field < 3; field++) {
    const value = readSshString(decoded, offset)
    if (!value) {
      return false
    }
    offset = value.nextOffset
  }
  if (offset + 4 > decoded.length) {
    return false
  }

  const keyCount = decoded.readUInt32BE(offset)
  offset += 4
  if (keyCount === 0 || keyCount > MAX_PUBLIC_KEYS) {
    return false
  }

  let hasSecurityKey = false
  for (let keyIndex = 0; keyIndex < keyCount; keyIndex++) {
    const publicKey = readSshString(decoded, offset)
    if (!publicKey) {
      return false
    }
    offset = publicKey.nextOffset
    const keyType = readSshString(publicKey.value, 0)
    if (!keyType) {
      return false
    }
    hasSecurityKey ||= SECURITY_KEY_TYPES.has(keyType.value.toString('ascii'))
  }

  const privateBlock = readSshString(decoded, offset)
  return privateBlock !== null && hasSecurityKey
}

export function isOpenSshSecurityKeyPublicKey(contents: Buffer): boolean {
  if (contents.length > MAX_SSH_IDENTITY_FILE_BYTES) {
    return false
  }
  const [declaredType, encoded] = contents.toString('ascii').trim().split(/\s+/, 3)
  if (!declaredType || !encoded || !SECURITY_KEY_TYPES.has(declaredType)) {
    return false
  }
  const decoded = decodeBase64(encoded)
  if (!decoded) {
    return false
  }
  const keyType = readSshString(decoded, 0)
  return keyType?.value.toString('ascii') === declaredType
}
