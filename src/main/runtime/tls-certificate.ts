// Why: the WebSocket transport uses wss:// with a self-signed TLS certificate
// to prevent passive sniffing of device tokens on shared WiFi networks. The
// cert is generated once on first run and reused across restarts. The mobile
// app pins the certificate fingerprint received during QR pairing.
import { createHash } from 'crypto'
import { generateKeyPairSync, randomBytes, sign } from 'crypto'
import { existsSync, readFileSync, chmodSync, writeFileSync } from 'fs'
import { join } from 'path'

const TLS_CERT_FILENAME = 'orca-tls-cert.pem'
const TLS_KEY_FILENAME = 'orca-tls-key.pem'

export type TlsCertificate = {
  cert: string
  key: string
  fingerprint: string
}

export function loadOrCreateTlsCertificate(userDataPath: string): TlsCertificate {
  const certPath = join(userDataPath, TLS_CERT_FILENAME)
  const keyPath = join(userDataPath, TLS_KEY_FILENAME)

  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf-8')
    const key = readFileSync(keyPath, 'utf-8')
    const fingerprint = computeFingerprint(cert)
    if (fingerprint) {
      return { cert, key, fingerprint }
    }
    // Why: if the existing cert is malformed (e.g., from a buggy earlier
    // generation), regenerate rather than failing the WebSocket transport.
  }

  const keyPath_ = join(userDataPath, TLS_KEY_FILENAME)
  const certPath_ = join(userDataPath, TLS_CERT_FILENAME)

  const generated = generateSelfSignedCertificate()
  writeFileSync(keyPath_, generated.key)
  writeFileSync(certPath_, generated.cert)

  chmodSync(keyPath_, 0o600)
  chmodSync(certPath_, 0o600)

  const cert = readFileSync(certPath_, 'utf-8')
  const key = readFileSync(keyPath_, 'utf-8')
  return { cert, key, fingerprint: computeFingerprint(cert)! }
}

function generateSelfSignedCertificate(): { cert: string; key: string } {
  // Why: packaged Windows installs cannot assume openssl or POSIX shell
  // redirection exists, so first-run pairing must generate PEMs in-process.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
  })
  const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKeyInfo = publicKey.export({ type: 'spki', format: 'der' }) as Buffer
  const algorithm = sequence(
    objectIdentifier('1.2.840.113549.1.1.11'),
    tagged(0x05, Buffer.alloc(0))
  )
  const subject = name('Orca Runtime')
  const tbsCertificate = sequence(
    integer(randomBytes(16)),
    algorithm,
    subject,
    sequence(generalizedTime(new Date(Date.now() - 60_000)), generalizedTime(daysFromNow(3650))),
    subject,
    publicKeyInfo
  )
  const signature = sign('sha256', tbsCertificate, privateKey)
  const cert = sequence(tbsCertificate, algorithm, bitString(signature))
  return { cert: toPem('CERTIFICATE', cert), key }
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000)
}

function toPem(label: string, der: Buffer): string {
  const body =
    der
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}

function name(commonName: string): Buffer {
  return sequence(
    set(sequence(objectIdentifier('2.5.4.3'), tagged(0x0c, Buffer.from(commonName, 'utf8'))))
  )
}

function generalizedTime(date: Date): Buffer {
  const value = [
    date.getUTCFullYear(),
    `${date.getUTCMonth() + 1}`.padStart(2, '0'),
    `${date.getUTCDate()}`.padStart(2, '0'),
    `${date.getUTCHours()}`.padStart(2, '0'),
    `${date.getUTCMinutes()}`.padStart(2, '0'),
    `${date.getUTCSeconds()}`.padStart(2, '0'),
    'Z'
  ].join('')
  return tagged(0x18, Buffer.from(value, 'ascii'))
}

function sequence(...items: Buffer[]): Buffer {
  return tagged(0x30, Buffer.concat(items))
}

function set(...items: Buffer[]): Buffer {
  return tagged(0x31, Buffer.concat(items))
}

function integer(value: Buffer): Buffer {
  const firstNonZero = value.findIndex((byte) => byte !== 0)
  const trimmed = firstNonZero === -1 ? Buffer.from([0]) : value.subarray(firstNonZero)
  return tagged(0x02, trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed)
}

function bitString(value: Buffer): Buffer {
  return tagged(0x03, Buffer.concat([Buffer.from([0]), value]))
}

function objectIdentifier(value: string): Buffer {
  const parts = value.split('.').map((part) => Number(part))
  const bytes = [parts[0]! * 40 + parts[1]!]
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f]
    let remaining = part >> 7
    while (remaining > 0) {
      encoded.unshift((remaining & 0x7f) | 0x80)
      remaining >>= 7
    }
    bytes.push(...encoded)
  }
  return tagged(0x06, Buffer.from(bytes))
}

function tagged(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content])
}

function lengthBytes(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length])
  }
  const bytes: number[] = []
  let remaining = length
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff)
    remaining >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function computeFingerprint(certPem: string): string | null {
  const derMatch = certPem.match(
    /-----BEGIN CERTIFICATE-----\n([\s\S]+?)\n-----END CERTIFICATE-----/
  )
  if (!derMatch?.[1]) {
    return null
  }
  const der = Buffer.from(derMatch[1].replace(/\n/g, ''), 'base64')
  const hash = createHash('sha256').update(der).digest('hex')
  return `sha256:${hash}`
}
