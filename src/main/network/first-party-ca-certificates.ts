import { createHash, X509Certificate } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'
import { mapWithConcurrency } from '../../shared/map-with-concurrency'

const PEM_CERTIFICATE_PATTERN = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g
const MACOS_SECURITY = join('/', 'usr', 'bin', 'security')
const MACOS_TRUST_LOAD_TIMEOUT_MS = 10_000
const MACOS_TRUST_VERIFY_CONCURRENCY = 8
const LINUX_CA_BUNDLES = [
  join('/', 'etc', 'ssl', 'certs', 'ca-certificates.crt'),
  join('/', 'etc', 'ssl', 'certs', 'ca-bundle.crt'),
  join('/', 'etc', 'ssl', 'ca-bundle.pem'),
  join('/', 'etc', 'pki', 'tls', 'certs', 'ca-bundle.crt'),
  join('/', 'etc', 'pki', 'ca-trust', 'extracted', 'pem', 'tls-ca-bundle.pem')
]

type WindowsCaModule = {
  exportSystemCertificatesAsync(options: {
    store: string
    storeTypeList: string[]
  }): Promise<string[]>
}

const WINDOWS_STORE_TYPES = ['CERT_SYSTEM_STORE_LOCAL_MACHINE', 'CERT_SYSTEM_STORE_CURRENT_USER']

type ReadTextFile = (path: string, encoding: 'utf8', signal?: AbortSignal) => Promise<string>

type CertificateSources = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: number
  readFile?: ReadTextFile
  runProcess?: (spec: Parameters<typeof runProcess>[0]) => Promise<ProcessResult>
  loadWindowsCaModule?: () => Promise<WindowsCaModule>
  trustLoadTimeoutMs?: number
}

export type LegacySystemCaPolicy = {
  certificates: string[]
  disallowedDigests: ReadonlySet<string>
}

const requireFromMain = createRequire(__filename)

function parsePemCertificates(value: string): string[] {
  return value.match(PEM_CERTIFICATE_PATTERN) ?? []
}

function isCurrentCaCertificate(pem: string, now: number): boolean {
  try {
    const certificate = new X509Certificate(pem)
    const validFrom = Date.parse(certificate.validFrom)
    const validTo = Date.parse(certificate.validTo)
    return certificate.ca && validFrom <= now && validTo > now
  } catch {
    return false
  }
}

function filterCurrentCaCertificates(certificates: string[], now: number): string[] {
  return [...new Set(certificates)].filter((pem) => isCurrentCaCertificate(pem, now))
}

function certificateDigest(pem: string): string | undefined {
  try {
    return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex')
  } catch {
    return undefined
  }
}

async function loadWindowsCertificates(
  loadModule: NonNullable<CertificateSources['loadWindowsCaModule']>,
  now: number
): Promise<LegacySystemCaPolicy> {
  const module = await loadModule()
  const readStore = async (store: string): Promise<string[]> => {
    const results = await Promise.allSettled(
      WINDOWS_STORE_TYPES.map((storeType) =>
        module.exportSystemCertificatesAsync({ store, storeTypeList: [storeType] })
      )
    )
    return results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  }
  const [trusted, blocked] = await Promise.all([readStore('ROOT'), readStore('Disallowed')])
  const disallowedDigests = new Set(
    blocked.map(certificateDigest).filter((digest): digest is string => digest !== undefined)
  )
  const certificates = filterCurrentCaCertificates(trusted, now).filter((pem) => {
    const digest = certificateDigest(pem)
    return digest !== undefined && !disallowedDigests.has(digest)
  })
  return { certificates, disallowedDigests }
}

async function loadMacCertificates(
  execute: NonNullable<CertificateSources['runProcess']>,
  now: number,
  timeoutMs: number
): Promise<string[]> {
  const signal = AbortSignal.timeout(timeoutMs)
  const listed = await execute({
    program: MACOS_SECURITY,
    args: ['find-certificate', '-a', '-p'],
    timeoutMs,
    signal,
    maxOutputBytes: 64 * 1024 * 1024
  })
  if (listed.code !== 0 || listed.timedOut || signal.aborted) {
    return []
  }
  const candidates = filterCurrentCaCertificates(parsePemCertificates(listed.stdout), now).filter(
    (pem) => {
      const certificate = new X509Certificate(pem)
      return certificate.checkIssued(certificate)
    }
  )
  const trusted = await mapWithConcurrency(
    candidates,
    MACOS_TRUST_VERIFY_CONCURRENCY,
    async (certificate): Promise<string | undefined> => {
      const verified = await execute({
        program: MACOS_SECURITY,
        args: ['verify-cert', '-c', join('/', 'dev', 'stdin'), '-p', 'basic', '-l', '-L', '-q'],
        input: certificate,
        timeoutMs: 5_000,
        signal
      })
      return verified.code === 0 && !verified.timedOut && !signal.aborted ? certificate : undefined
    }
  )
  return trusted.filter((certificate): certificate is string => certificate !== undefined)
}

function withinDeadline<T>(operation: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs)
    timer.unref()
  })
  return Promise.race([operation, expired]).finally(() => clearTimeout(timer))
}

async function loadLinuxCertificates(
  env: NodeJS.ProcessEnv,
  loadFile: ReadTextFile,
  now: number,
  signal: AbortSignal
): Promise<string[]> {
  const paths = [...(env.SSL_CERT_FILE ? [env.SSL_CERT_FILE] : []), ...LINUX_CA_BUNDLES]
  for (const path of paths) {
    try {
      const certificates = filterCurrentCaCertificates(
        parsePemCertificates(await loadFile(path, 'utf8', signal)),
        now
      )
      if (certificates.length > 0) {
        return certificates
      }
    } catch {
      // Try the next policy-owned bundle location.
    }
  }
  return []
}

export async function loadCaCertificateFile(path: string | undefined): Promise<string[]> {
  if (!path) {
    return []
  }
  try {
    return filterCurrentCaCertificates(
      parsePemCertificates(
        await readFile(path, {
          encoding: 'utf8',
          signal: AbortSignal.timeout(MACOS_TRUST_LOAD_TIMEOUT_MS)
        })
      ),
      Date.now()
    )
  } catch {
    return []
  }
}

export function applyLegacySystemCaPolicy(
  certificates: string[],
  policy: LegacySystemCaPolicy
): string[] {
  return certificates.filter((pem) => {
    const digest = certificateDigest(pem)
    return digest !== undefined && !policy.disallowedDigests.has(digest)
  })
}

export async function loadLegacySystemCaPolicy(
  sources: CertificateSources = {}
): Promise<LegacySystemCaPolicy> {
  const platform = sources.platform ?? process.platform
  const env = sources.env ?? process.env
  const now = sources.now ?? Date.now()
  const loadFile = sources.readFile ?? readFile
  const execute = sources.runProcess ?? runProcess
  const trustLoadTimeoutMs = sources.trustLoadTimeoutMs ?? MACOS_TRUST_LOAD_TIMEOUT_MS
  try {
    if (platform === 'darwin') {
      const certificates = await withinDeadline(
        loadMacCertificates(execute, now, trustLoadTimeoutMs),
        trustLoadTimeoutMs,
        []
      )
      return { certificates, disallowedDigests: new Set() }
    }
    if (platform === 'linux') {
      const signal = AbortSignal.timeout(trustLoadTimeoutMs)
      const certificates = await withinDeadline(
        loadLinuxCertificates(env, loadFile, now, signal),
        trustLoadTimeoutMs,
        []
      )
      return { certificates, disallowedDigests: new Set() }
    }
    if (platform === 'win32') {
      const loadModule =
        sources.loadWindowsCaModule ??
        (async () => requireFromMain('win-export-certificate-and-key') as WindowsCaModule)
      return await withinDeadline(loadWindowsCertificates(loadModule, now), trustLoadTimeoutMs, {
        certificates: [],
        disallowedDigests: new Set()
      })
    }
  } catch {
    // Bundled roots remain available if host trust enumeration fails.
  }
  return { certificates: [], disallowedDigests: new Set() }
}

export async function loadLegacySystemCaCertificates(
  sources: CertificateSources = {}
): Promise<string[]> {
  return (await loadLegacySystemCaPolicy(sources)).certificates
}
