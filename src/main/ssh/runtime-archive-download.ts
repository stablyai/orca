/** Streams and hash-checks a pinned runtime archive, and extracts it with the host's own tools. */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { runProcess, type ProcessResult } from '../../shared/child-process/run-process'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { getZipExtractorCommand } from '../../shared/zip-extractor-command'
import type { MainHttpClient } from '../network/http-client'
import type { PinnedRuntimeArchive, PinnedRuntimeExecutable } from './pinned-runtime-materializer'

const MAX_RUNTIME_ARCHIVE_BYTES = 200 * 1024 * 1024

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

export async function downloadVerifiedArchive(
  archive: PinnedRuntimeArchive,
  destination: string,
  fetcher: MainHttpClient['fetch'],
  signal?: AbortSignal
): Promise<void> {
  const { label, url, archiveSha256: expectedSha256 } = archive
  const stall = new AbortController()
  const downloadSignal = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal
  const stallTimer = setTimeout(() => stall.abort(new Error(`${label} download stalled`)), 120_000)
  try {
    const response = await fetcher(url, { redirect: 'follow', signal: downloadSignal })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`${label} download failed: ${response.status} ${response.statusText}`)
    }
    const declaredLength = Number(response.headers.get('content-length'))
    if (Number.isFinite(declaredLength) && declaredLength > MAX_RUNTIME_ARCHIVE_BYTES) {
      await response.body.cancel().catch(() => undefined)
      throw new Error(`${label} download exceeded the archive size limit`)
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
        if (total > MAX_RUNTIME_ARCHIVE_BYTES) {
          throw new Error(`${label} download exceeded the archive size limit`)
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
      throw new Error(
        `${label} archive checksum mismatch: expected ${expectedSha256}, got ${actual}`
      )
    }
  } finally {
    clearTimeout(stallTimer)
  }
}

async function writeAll(
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
