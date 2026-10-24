/** Streams and hash-checks a pinned runtime archive, and extracts it with the host's own tools. */
import { createHash } from 'node:crypto'
import { open, rm } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getZipExtractorCommand } from '../../shared/zip-extractor-command'
import type { MainHttpClient } from '../network/http-client'
import { isRetryableDownloadError, type HttpStatusError } from '../network/transient-download-error'
import type { PinnedRuntimeArchive, PinnedRuntimeExecutable } from './pinned-runtime-materializer'

const MAX_RUNTIME_ARCHIVE_BYTES = 200 * 1024 * 1024
/** Pauses before attempts 2..n; a network change or a CDN 5xx usually clears within seconds. */
export const RUNTIME_ARCHIVE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000]

/**
 * Why the extractor needs a message of its own: `unzip` is absent from a minimal POSIX install,
 * and a bare `spawn unzip ENOENT` names neither the missing tool nor the override. A misconfigured
 * `ORCA_UNZIP_BIN` whose parent is a file reports ENOTDIR instead, which is the same verdict.
 *
 * The errno is the program path's, not the caller's: `runProcess` leaves cwd unset, so the child
 * inherits the parent's without resolving it. Measured on macOS, Linux and Windows — spawn still
 * succeeds from a deleted cwd, even though `process.cwd()` itself throws ENOENT there.
 */
export async function extractRuntimeArchive(
  runtime: Pick<PinnedRuntimeExecutable, 'label' | 'member'>,
  archivePath: string,
  extractDir: string,
  signal?: AbortSignal
): Promise<ProcessResult> {
  const { label } = runtime
  // Why tar for .tar.gz: every POSIX host and Windows 10+ ships it; Node publishes no zip there.
  const command = archivePath.endsWith('.zip')
    ? getZipExtractorCommand(archivePath, extractDir)
    : {
        file: 'tar',
        args: ['-xzf', archivePath, '-C', extractDir, runtime.member],
        label: 'tar'
      }
  try {
    return await runProcess({
      program: command.file,
      args: command.args,
      timeoutMs: 120_000,
      signal
    })
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      const override = archivePath.endsWith('.zip')
        ? ', or set ORCA_UNZIP_BIN to an unzip-compatible extractor.'
        : '.'
      throw new Error(
        `${label} archive extraction could not run ${command.file}: install ${command.label}${override}`,
        { cause: error }
      )
    }
    throw error
  }
}

/** The served file isn't the pinned release (missing, oversized or a different checksum), so no
 *  retry or network fix helps; only a newer Orca does. */
export class ReleaseMismatchError extends Error {}

/** What the person can do about a failed download. Only a proven mismatch blames the release;
 *  every other failure (proxy, DNS, TLS, a dropped connection) is one the network can fix. */
export function downloadFailureMessage(label: string, error: unknown): string {
  return error instanceof ReleaseMismatchError
    ? `The ${label} download didn't match the release Orca expects, so nothing was installed. Updating Orca may fix this.`
    : `Couldn't download ${label}. Check your network connection or proxy, then try again.`
}

/** Retries transient network failures; a checksum mismatch or a cancel is final. */
export async function downloadVerifiedArchive(
  archive: PinnedRuntimeArchive,
  destination: string,
  fetcher: MainHttpClient['fetch'],
  signal?: AbortSignal,
  retryDelaysMs: readonly number[] = RUNTIME_ARCHIVE_RETRY_DELAYS_MS,
  /** The bytes this attempt has read so far; a retry counts from zero again. */
  onBytes?: (bytes: number) => void
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await downloadVerifiedArchiveOnce(archive, destination, fetcher, signal, onBytes)
      return
    } catch (error) {
      const delay = retryDelaysMs[attempt]
      if (delay === undefined || signal?.aborted || !isRetryableDownloadError(error)) {
        throw error
      }
      console.warn(
        `[ssh] ${archive.label} download failed; retrying in ${delay}ms (attempt ${attempt + 2}):`,
        error instanceof Error ? error.message : error
      )
      // Why: each attempt opens the destination exclusively, so a partial file must go first.
      await rm(destination, { force: true })
      await waitForPromiseWithSignal(new Promise((resolve) => setTimeout(resolve, delay)), signal)
    }
  }
}

async function downloadVerifiedArchiveOnce(
  archive: PinnedRuntimeArchive,
  destination: string,
  fetcher: MainHttpClient['fetch'],
  signal?: AbortSignal,
  onBytes?: (bytes: number) => void
): Promise<void> {
  const { label, url, archiveSha256: expectedSha256 } = archive
  const maxBytes = archive.maxArchiveBytes ?? MAX_RUNTIME_ARCHIVE_BYTES
  const stall = new AbortController()
  const downloadSignal = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal
  const stalled: HttpStatusError = Object.assign(new Error(`${label} download stalled`), {
    retryable: true
  })
  const stallTimer = setTimeout(() => stall.abort(stalled), 120_000)
  try {
    // no-store: the verified file is the only copy, so Remove frees the space and a retry refetches.
    const response = await fetcher(url, {
      redirect: 'follow',
      cache: 'no-store',
      signal: downloadSignal
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      const text = `${label} download failed: ${response.status} ${response.statusText}`
      const missing = response.status === 404 || response.status === 410
      throw Object.assign(missing ? new ReleaseMismatchError(text) : new Error(text), {
        httpStatusCode: response.status
      })
    }
    // A compressed body declares its encoded size; the decoded bytes are still capped and hashed.
    const encoding = response.headers.get('content-encoding')?.trim().toLowerCase() || 'identity'
    const declaredLength = Number(response.headers.get('content-length'))
    if (encoding === 'identity' && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body.cancel().catch(() => undefined)
      throw new ReleaseMismatchError(`${label} download exceeded the archive size limit`)
    }
    const handle = await open(destination, 'wx', 0o600).catch(async (error) => {
      await response.body?.cancel().catch(() => undefined)
      throw error
    })
    const reader = response.body.getReader()
    const hash = createHash('sha256')
    let total = 0
    try {
      for (;;) {
        downloadSignal.throwIfAborted()
        const chunk = await waitForPromiseWithSignal(reader.read(), downloadSignal)
        if (chunk.done) {
          break
        }
        if (chunk.value.byteLength > 0) {
          stallTimer.refresh()
        }
        total += chunk.value.byteLength
        onBytes?.(total)
        if (total > maxBytes) {
          throw new ReleaseMismatchError(`${label} download exceeded the archive size limit`)
        }
        hash.update(chunk.value)
        await writeAll(handle, chunk.value)
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined)
      throw error
    } finally {
      await handle.close()
    }
    const actual = hash.digest('hex')
    if (actual !== expectedSha256) {
      throw new ReleaseMismatchError(
        `${label} archive checksum mismatch: expected ${expectedSha256}, got ${actual}`
      )
    }
  } catch (error) {
    // Why: the fetch may reject a stalled abort with its own AbortError rather than our reason.
    const downloadError = stall.signal.aborted && !signal?.aborted ? stalled : error
    stall.abort()
    throw downloadError
  } finally {
    clearTimeout(stallTimer)
  }
}

export async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array
): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset)
    if (bytesWritten === 0) {
      throw new Error('Runtime archive write made no progress')
    }
    offset += bytesWritten
  }
}
