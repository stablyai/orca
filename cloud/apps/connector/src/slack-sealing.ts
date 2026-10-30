import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// AES-256-GCM under the Slack token key. The AAD names what the value is and which row holds it, so
// a sealed value copied to another column or row won't open.
export function sealSecret(key: Buffer, aad: string, value: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(aad))
  const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return ['v1', ...[iv, cipher.getAuthTag(), sealed].map((part) => part.toString('base64'))].join(
    '.'
  )
}

export function openSecret(key: Buffer, aad: string, sealed: string): string {
  const [version, iv, tag, data] = sealed.split('.')
  if (version !== 'v1' || !iv || !tag || !data) {
    throw new Error('unreadable sealed secret')
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    .setAAD(Buffer.from(aad))
    .setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
    'utf8'
  )
}
