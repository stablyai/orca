// Why: the WebSocket transport uses wss:// with a self-signed TLS certificate
// to prevent passive sniffing of device tokens on shared WiFi networks. The
// cert is generated once on first run and reused across restarts. The mobile
// app pins the certificate fingerprint received during QR pairing.
import { createHash } from 'crypto'
import { execSync } from 'child_process'
import { existsSync, readFileSync, chmodSync } from 'fs'
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

  // Why: openssl is available on macOS, Linux, and Windows (via Git Bash).
  // Using it avoids hand-rolling ASN.1 DER encoding which is error-prone.
  execSync(
    `openssl req -new -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
      `-nodes -days 3650 -subj "/CN=Orca Runtime" ` +
      `-keyout "${keyPath_}" -out "${certPath_}" 2>/dev/null`
  )

  chmodSync(keyPath_, 0o600)
  chmodSync(certPath_, 0o600)

  const cert = readFileSync(certPath_, 'utf-8')
  const key = readFileSync(keyPath_, 'utf-8')
  return { cert, key, fingerprint: computeFingerprint(cert)! }
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
