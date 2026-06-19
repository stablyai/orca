// Why: the WebSocket transport uses wss:// with a self-signed TLS certificate
// to prevent passive sniffing of device tokens on shared WiFi networks. The
// cert is generated once on first run and reused across restarts. The mobile
// app pins the certificate fingerprint received during QR pairing.
import { createHash } from 'crypto'
import { execFileSync } from 'child_process'
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

  // Why: argv-based spawning avoids shell redirection/quoting differences for
  // Windows temp paths while keeping OpenSSL as the certificate generator.
  const openSslConfigPath = resolveOpenSslConfigPath()
  execFileSync(
    resolveOpenSslExecutable(),
    [
      'req',
      '-new',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '3650',
      '-subj',
      '/CN=Orca Runtime',
      '-keyout',
      keyPath_,
      '-out',
      certPath_
    ],
    {
      env: openSslConfigPath ? { ...process.env, OPENSSL_CONF: openSslConfigPath } : process.env,
      stdio: 'ignore'
    }
  )

  chmodSync(keyPath_, 0o600)
  chmodSync(certPath_, 0o600)

  const cert = readFileSync(certPath_, 'utf-8')
  const key = readFileSync(keyPath_, 'utf-8')
  return { cert, key, fingerprint: computeFingerprint(cert)! }
}

function resolveOpenSslExecutable(): string {
  if (process.platform !== 'win32') {
    return 'openssl'
  }

  const windowsCandidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\mingw64\\bin\\openssl.exe'
  ]
  return windowsCandidates.find((candidate) => existsSync(candidate)) ?? 'openssl'
}

function resolveOpenSslConfigPath(): string | null {
  if (process.env.OPENSSL_CONF && existsSync(process.env.OPENSSL_CONF)) {
    return null
  }

  if (process.platform !== 'win32') {
    return null
  }

  const windowsConfigCandidates = [
    'C:\\Program Files\\Git\\mingw64\\etc\\ssl\\openssl.cnf',
    'C:\\Program Files\\Git\\usr\\ssl\\openssl.cnf',
    'C:\\Program Files (x86)\\Git\\mingw64\\etc\\ssl\\openssl.cnf',
    'C:\\Program Files (x86)\\Git\\usr\\ssl\\openssl.cnf'
  ]
  return windowsConfigCandidates.find((candidate) => existsSync(candidate)) ?? null
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
