import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SKILL_PACKAGE_CONTENT_TYPE,
  SKILL_PACKAGE_MAX_COMPRESSED_BYTES
} from '../../shared/skill-package-manifest'
import {
  createSkillDownloadAvailabilitySignal,
  isSkillDownloadGrantExpiredAbort,
  throwIfSkillDownloadUnavailable
} from './skill-package-download-availability'
import { startSkillPhaseOperation } from './skill-operation-observability'

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 3
const PROCESS_DOWNLOAD_ROOT_PREFIX = '.orca-skill-download-process-'
const processDownloadRootName = `${PROCESS_DOWNLOAD_ROOT_PREFIX}${process.pid}-${randomUUID()}`
const initializedTemporaryRoots = new Map<string, Promise<string>>()

export type SkillPackageDownloadResult = {
  archivePath: string
  archiveSha256: string
  compressedBytes: number
  cleanup(): Promise<void>
}

type SkillPackageDownloadInput = {
  url: string
  expiresAt: string
  expectedArchiveSha256: string
  expectedCompressedBytes: number
  temporaryRoot: string
  allowedOrigins: readonly string[]
  requireHttps: boolean
  signal?: AbortSignal
  fetcher?: typeof fetch
  now?: () => number
}

function validateIdentity(input: SkillPackageDownloadInput): void {
  if (!/^[a-f0-9]{64}$/.test(input.expectedArchiveSha256)) {
    throw new Error('skill-download-archive-identity-invalid')
  }
  if (
    !Number.isInteger(input.expectedCompressedBytes) ||
    input.expectedCompressedBytes < 1 ||
    input.expectedCompressedBytes > SKILL_PACKAGE_MAX_COMPRESSED_BYTES
  ) {
    throw new Error('skill-download-size-invalid')
  }
}

function validateUrl(
  value: string,
  allowedOrigins: ReadonlySet<string>,
  requireHttps: boolean
): URL {
  const url = new URL(value)
  if (url.username || url.password || (requireHttps && url.protocol !== 'https:')) {
    throw new Error('skill-download-url-rejected')
  }
  if (!allowedOrigins.has(url.origin)) {
    throw new Error('skill-download-origin-rejected')
  }
  return url
}

async function fetchWithoutCredentialRedirect(
  input: SkillPackageDownloadInput,
  allowedOrigins: ReadonlySet<string>,
  expiresAt: number,
  signal: AbortSignal
): Promise<Response> {
  let url = validateUrl(input.url, allowedOrigins, input.requireHttps)
  for (let redirectCount = 0; ; redirectCount += 1) {
    throwIfSkillDownloadUnavailable({
      signal: input.signal,
      now: input.now!,
      expiresAt
    })
    let response: Response
    try {
      response = await input.fetcher!(url, {
        method: 'GET',
        redirect: 'manual',
        signal
      })
    } catch {
      if (input.signal?.aborted) {
        throwIfSkillDownloadUnavailable({
          signal: input.signal,
          now: input.now!,
          expiresAt
        })
      }
      if (isSkillDownloadGrantExpiredAbort(signal)) {
        throw new Error('skill-download-grant-expired')
      }
      throw new Error('skill-download-transport-failed')
    }
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response
    }
    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error('skill-download-redirect-limit')
    }
    const location = response.headers.get('location')
    if (!location) {
      throw new Error('skill-download-redirect-invalid')
    }
    const redirected = validateUrl(new URL(location, url).href, allowedOrigins, input.requireHttps)
    if (redirected.origin !== url.origin) {
      throw new Error('skill-download-cross-origin-redirect')
    }
    url = redirected
  }
}

function hashesEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function prepareTemporaryRoot(path: string): Promise<string> {
  let initialization = initializedTemporaryRoots.get(path)
  if (!initialization) {
    initialization = (async () => {
      await mkdir(path, { recursive: true, mode: 0o700 })
      if (process.platform !== 'win32') {
        await chmod(path, 0o700)
      }
      const entries = await readdir(path, { withFileTypes: true })
      await Promise.all(
        entries.map(async (entry) => {
          const match = entry.isDirectory()
            ? entry.name.match(/^\.orca-skill-download-process-(\d+)-/)
            : null
          const pid = Number(match?.[1])
          if (match && Number.isSafeInteger(pid) && !processIsAlive(pid)) {
            await rm(join(path, entry.name), { recursive: true, force: true })
          }
        })
      )
      const processRoot = join(path, processDownloadRootName)
      await mkdir(processRoot, { recursive: true, mode: 0o700 })
      return processRoot
    })()
    initializedTemporaryRoots.set(path, initialization)
  }
  try {
    return await initialization
  } catch (error) {
    if (initializedTemporaryRoots.get(path) === initialization) {
      initializedTemporaryRoots.delete(path)
    }
    throw error
  }
}

async function downloadSkillPackageGrantUnobserved(
  input: SkillPackageDownloadInput
): Promise<SkillPackageDownloadResult> {
  input.fetcher ??= fetch
  input.now ??= Date.now
  validateIdentity(input)
  const expiresAt = Date.parse(input.expiresAt)
  if (!Number.isFinite(expiresAt)) {
    throw new Error('skill-download-grant-expiry-invalid')
  }
  const allowedOrigins = new Set(
    input.allowedOrigins.map(
      (origin) => validateUrl(origin, new Set([new URL(origin).origin]), false).origin
    )
  )
  throwIfSkillDownloadUnavailable({ signal: input.signal, now: input.now!, expiresAt })
  const availability = createSkillDownloadAvailabilitySignal({
    signal: input.signal,
    now: input.now!,
    expiresAt
  })
  try {
    const response = await fetchWithoutCredentialRedirect(
      input,
      allowedOrigins,
      expiresAt,
      availability.signal
    )
    if (!response.ok || !response.body) {
      throw new Error('skill-download-transport-failed')
    }
    if (response.headers.get('content-type')?.split(';', 1)[0] !== SKILL_PACKAGE_CONTENT_TYPE) {
      throw new Error('skill-download-content-type-invalid')
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength !== null && Number(contentLength) !== input.expectedCompressedBytes) {
      throw new Error('skill-download-size-mismatch')
    }

    const processRoot = await prepareTemporaryRoot(input.temporaryRoot)
    const temporaryDirectory = await mkdtemp(join(processRoot, '.orca-skill-download-'))
    const archivePath = join(temporaryDirectory, 'package.tar.gz')
    try {
      const handle = await open(archivePath, 'wx', 0o600)
      const reader = response.body.getReader()
      const hash = createHash('sha256')
      let compressedBytes = 0
      try {
        for (;;) {
          throwIfSkillDownloadUnavailable({
            signal: input.signal,
            now: input.now!,
            expiresAt
          })
          const chunk = await reader.read()
          if (chunk.done) {
            break
          }
          compressedBytes += chunk.value.byteLength
          if (
            compressedBytes > input.expectedCompressedBytes ||
            compressedBytes > SKILL_PACKAGE_MAX_COMPRESSED_BYTES
          ) {
            throw new Error('skill-download-size-limit')
          }
          hash.update(chunk.value)
          let offset = 0
          while (offset < chunk.value.byteLength) {
            const written = await handle.write(chunk.value, offset, chunk.value.byteLength - offset)
            if (written.bytesWritten === 0) {
              throw new Error('skill-download-write-failed')
            }
            offset += written.bytesWritten
          }
        }
        await handle.sync()
      } catch (error) {
        await reader.cancel().catch(() => undefined)
        if (input.signal?.aborted) {
          throwIfSkillDownloadUnavailable({
            signal: input.signal,
            now: input.now!,
            expiresAt
          })
        }
        if (isSkillDownloadGrantExpiredAbort(availability.signal)) {
          throw new Error('skill-download-grant-expired')
        }
        throw error
      } finally {
        await handle.close()
      }
      if (compressedBytes !== input.expectedCompressedBytes) {
        throw new Error('skill-download-size-mismatch')
      }
      const archiveSha256 = hash.digest('hex')
      if (!hashesEqual(archiveSha256, input.expectedArchiveSha256)) {
        throw new Error('skill-download-archive-digest-mismatch')
      }
      return {
        archivePath,
        archiveSha256,
        compressedBytes,
        cleanup: () => rm(temporaryDirectory, { recursive: true, force: true })
      }
    } catch (error) {
      await rm(temporaryDirectory, { recursive: true, force: true })
      throw error
    }
  } finally {
    availability.cleanup()
  }
}

export async function downloadSkillPackageGrant(
  input: SkillPackageDownloadInput
): Promise<SkillPackageDownloadResult> {
  const operation = startSkillPhaseOperation({
    phase: 'download',
    transport: 'download-grant',
    compressedBytes: input.expectedCompressedBytes
  })
  try {
    const downloaded = await downloadSkillPackageGrantUnobserved(input)
    operation.complete({ status: 'complete', compressedBytes: downloaded.compressedBytes })
    return downloaded
  } catch (error) {
    operation.fail(error)
    throw error
  }
}
