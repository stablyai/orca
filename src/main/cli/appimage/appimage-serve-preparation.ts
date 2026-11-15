// Share one deadline across the registration lock and all first-serve extraction attempts.
import { randomUUID } from 'node:crypto'
import { mkdir, stat, statfs, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  ensureAppImageExtractedRoot,
  isAppImageExtractionComplete,
  resolveAppImageCacheRootPath,
  resolveAppImageExtractedRoot,
  type AppImageExtractionOptions
} from './appimage-extracted-root'
import { APPIMAGE_EXTRACTION_TIMEOUT_MS } from './appimage-extraction-pruning'
import { withAppImageRegistrationLock } from './appimage-registration-lock'

export const APPIMAGE_SERVE_PREPARATION_BUDGET_MS = APPIMAGE_EXTRACTION_TIMEOUT_MS
const PROGRESS_INTERVAL_MS = 15_000
// An extracted payload is about 2.7x the AppImage file; leave headroom for the staging copy.
const FREE_SPACE_FACTOR = 3

export type AppImageServePreparation =
  | { status: 'ready'; deadlineAt: number }
  | { status: 'unavailable'; reason: string; deadlineAt: number }

export type AppImageServePreparationOptions = Omit<AppImageExtractionOptions, 'deadlineAt'> & {
  budgetMs?: number
  progressIntervalMs?: number
  log?: (line: string) => void
  probeCache?: (cacheRootPath: string, appImagePath: string) => Promise<string | null>
}

export async function prepareAppImageCopyForServe(
  options: AppImageServePreparationOptions
): Promise<AppImageServePreparation> {
  const budgetMs = options.budgetMs ?? APPIMAGE_SERVE_PREPARATION_BUDGET_MS
  const deadlineAt = Date.now() + budgetMs
  const log = options.log ?? ((line: string) => console.log(line))
  const root = resolveAppImageExtractedRoot(options)
  if (!root) {
    return { status: 'unavailable', reason: 'the AppImage file is not readable', deadlineAt }
  }
  if (isAppImageExtractionComplete(root)) {
    return { status: 'ready', deadlineAt }
  }
  const cacheRootPath = resolveAppImageCacheRootPath(options)
  const startedAt = Date.now()
  log(
    `[serve] First start of this AppImage: unpacking a stable copy into ${cacheRootPath} ` +
      `(up to ${formatSeconds(budgetMs)})`
  )
  const refusal = await (options.probeCache ?? probeAppImageCache)(
    cacheRootPath,
    options.appImagePath
  )
  if (refusal) {
    log(`[serve] Cannot unpack the AppImage copy: ${refusal}`)
    return { status: 'unavailable', reason: refusal, deadlineAt }
  }
  const progress = setInterval(
    () =>
      log(
        `[serve] Still unpacking the AppImage copy (${formatSeconds(Date.now() - startedAt)} elapsed)`
      ),
    options.progressIntervalMs ?? PROGRESS_INTERVAL_MS
  )
  progress.unref?.()
  try {
    const extracted = await withAppImageRegistrationLock(
      cacheRootPath,
      () => ensureAppImageExtractedRoot({ ...options, deadlineAt }),
      { deadlineAt }
    )
    if (!extracted) {
      const reason =
        Date.now() >= deadlineAt
          ? `it did not finish within ${formatSeconds(budgetMs)}`
          : 'the AppImage could not be unpacked'
      log(`[serve] Cannot unpack the AppImage copy: ${reason}`)
      return { status: 'unavailable', reason, deadlineAt }
    }
    log(`[serve] AppImage copy ready after ${formatSeconds(Date.now() - startedAt)}`)
    return { status: 'ready', deadlineAt }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log(`[serve] Cannot unpack the AppImage copy: ${reason}`)
    return { status: 'unavailable', reason, deadlineAt }
  } finally {
    clearInterval(progress)
  }
}

/** Null when the cache is a private, writable directory that can run programs and has room. */
export async function probeAppImageCache(
  cacheRootPath: string,
  appImagePath: string
): Promise<string | null> {
  try {
    await mkdir(cacheRootPath, { recursive: true, mode: 0o700 })
    const stats = await stat(cacheRootPath)
    const uid = process.getuid?.()
    if (uid !== undefined && stats.uid !== uid) {
      return `${cacheRootPath} belongs to another user`
    }
    if ((stats.mode & 0o022) !== 0) {
      return `${cacheRootPath} is writable by other users`
    }
    const needed = (await stat(appImagePath)).size * FREE_SPACE_FACTOR
    const fsStats = await statfs(cacheRootPath)
    if (fsStats.bavail * fsStats.bsize < needed) {
      return `${cacheRootPath} needs about ${Math.ceil(needed / 1024 / 1024)} MB free`
    }
  } catch (error) {
    return `${cacheRootPath} is not usable (${describeError(error)})`
  }
  const probePath = join(cacheRootPath, `.exec-probe-${process.pid}-${randomUUID()}`)
  try {
    try {
      await writeFile(probePath, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    } catch (error) {
      return `${cacheRootPath} is not writable (${describeError(error)})`
    }
    try {
      const result = await runProcess({ program: probePath, args: [], timeoutMs: 5_000 })
      return result.code === 0 ? null : `${cacheRootPath} cannot run programs`
    } catch (error) {
      return `${cacheRootPath} cannot run programs (${describeError(error)}; is it mounted noexec?)`
    }
  } finally {
    await unlink(probePath).catch(() => {})
  }
}

function describeError(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code
  }
  return error instanceof Error ? error.message : String(error)
}

function formatSeconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`
}
