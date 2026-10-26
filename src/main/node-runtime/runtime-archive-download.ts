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
export const RUNTIME_ARCHIVE_RETRY_DELAYS_MS = [1_000, 3_000, 9_000]

/** Missing/misconfigured extractors need actionable errors; unset cwd means ENOENT/ENOTDIR identifies the program. */
export async function extractRuntimeArchive(
  runtime: Pick<PinnedRuntimeExecutable, 'label' | 'member'>,
  archivePath: string,
  extractDir: string,
  signal?: AbortSignal
): Promise<ProcessResult> {
  const { label } = runtime
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

/** Proven asset mismatch cannot recover through network retries. */
export class ReleaseMismatchError extends Error {}

/** Blame the release only for proven mismatch; transport failures remain network errors. */
export function downloadFailureMessage(label: string, error: unknown): string {
  return error instanceof ReleaseMismatchError
    ? `The ${label} download didn't match the release Orca expects, so nothing was installed. Updating Orca may fix this.`
    : `Couldn't download ${label}. Check your network connection or proxy, then try again.`
}

export async function downloadVerifiedArchive(
  archive: PinnedRuntimeArchive,
  destination: string,
  fetcher: MainHttpClient['fetch'],
  signal?: AbortSignal,
  retryDelaysMs: readonly number[] = RUNTIME_ARCHIVE_RETRY_DELAYS_MS,
  /** Restart from zero on each attempt. */
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
      // Each attempt opens exclusively, so remove partial bytes before retrying.
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
    // Verified files own the cache; no-store lets Remove free space and retries refetch.
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
    // Content-Length may describe compressed bytes; cap/hash the decoded body separately.
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
    // Normalize fetch’s own AbortError back to our stall reason unless the caller canceled.
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
