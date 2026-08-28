function encodeUint32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value)
  return buffer
}

function sshString(value: string | Buffer): Buffer {
  const contents = typeof value === 'string' ? Buffer.from(value, 'ascii') : value
  return Buffer.concat([encodeUint32(contents.length), contents])
}

export function createOpenSshPrivateKeyFixture(
  keyTypes: string[],
  options: { encrypted?: boolean; cipher?: string; privateBlock?: Buffer; authTag?: Buffer } = {}
): Buffer {
  const cipher = options.cipher ?? (options.encrypted ? 'aes256-ctr' : 'none')
  const encrypted = cipher !== 'none'
  const publicKeys = keyTypes.map((keyType) => sshString(sshString(keyType)))
  const decoded = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'ascii'),
    sshString(cipher),
    sshString(encrypted ? 'bcrypt' : 'none'),
    sshString(encrypted ? Buffer.from('fixture-kdf') : Buffer.alloc(0)),
    encodeUint32(publicKeys.length),
    ...publicKeys,
    sshString(options.privateBlock ?? Buffer.from('fixture-private-block')),
    options.authTag ?? Buffer.alloc(0)
  ])
  const encoded =
    decoded
      .toString('base64')
      .match(/.{1,70}/g)
      ?.join('\n') ?? ''
  return Buffer.from(
    `-----BEGIN OPENSSH PRIVATE KEY-----\n${encoded}\n-----END OPENSSH PRIVATE KEY-----\n`
  )
}

export function createOpenSshPublicKeyFixture(keyType: string): Buffer {
  const encoded = sshString(keyType).toString('base64')
  return Buffer.from(`${keyType} ${encoded} fixture-comment\n`)
}
