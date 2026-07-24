import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, opendir, rename, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type SpeechModelCacheDir = {
  modelsDir: string
  migrationSourceDir: string | null
}

const WINDOWS_SAFE_CACHE_HASH_LENGTH = 16
export const SPEECH_MODEL_CACHE_MIGRATION_MAX_ENTRIES = 16_384
export const SPEECH_MODEL_CACHE_MIGRATION_MAX_DEPTH = 16
export const SPEECH_MODEL_CACHE_MIGRATION_MAX_VISITED_PATH_BYTES = 16 * 1024 * 1024

export type SpeechModelCacheMigrationLimits = {
  maxEntries: number
  maxDepth: number
  maxVisitedPathBytes: number
}

class SpeechModelCacheMigrationBudget {
  private entries = 0
  private visitedPathBytes = 0
  private readonly limits: SpeechModelCacheMigrationLimits

  constructor(requested: Partial<SpeechModelCacheMigrationLimits>) {
    this.limits = {
      maxEntries: resolveMigrationLimit(
        requested.maxEntries,
        SPEECH_MODEL_CACHE_MIGRATION_MAX_ENTRIES,
        'maxEntries'
      ),
      maxDepth: resolveMigrationLimit(
        requested.maxDepth,
        SPEECH_MODEL_CACHE_MIGRATION_MAX_DEPTH,
        'maxDepth'
      ),
      maxVisitedPathBytes: resolveMigrationLimit(
        requested.maxVisitedPathBytes,
        SPEECH_MODEL_CACHE_MIGRATION_MAX_VISITED_PATH_BYTES,
        'maxVisitedPathBytes'
      )
    }
  }

  claim(sourcePath: string, targetPath: string, depth: number): void {
    if (depth > this.limits.maxDepth) {
      throw new Error(`Speech model cache migration exceeded depth ${this.limits.maxDepth}`)
    }
    this.entries += 1
    if (this.entries > this.limits.maxEntries) {
      throw new Error(`Speech model cache migration exceeded ${this.limits.maxEntries} entries`)
    }
    this.visitedPathBytes +=
      Buffer.byteLength(sourcePath, 'utf8') + Buffer.byteLength(targetPath, 'utf8')
    if (this.visitedPathBytes > this.limits.maxVisitedPathBytes) {
      throw new Error(
        `Speech model cache migration exceeded ${this.limits.maxVisitedPathBytes} visited path bytes`
      )
    }
  }
}

function resolveMigrationLimit(
  requested: number | undefined,
  maximum: number,
  name: string
): number {
  if (requested === undefined) {
    return maximum
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return Math.min(requested, maximum)
}

function hasNonAsciiCharacters(value: string): boolean {
  for (const character of value) {
    if (character.charCodeAt(0) > 0x7f) {
      return true
    }
  }
  return false
}

function getWindowsAsciiSharedDataRoots(): string[] {
  const publicDir = process.env.PUBLIC
  const systemDriveProgramData = process.env.SystemDrive
    ? `${process.env.SystemDrive}\\ProgramData`
    : undefined
  const candidates = [
    process.env.PROGRAMDATA,
    process.env.ProgramData,
    process.env.ALLUSERSPROFILE,
    process.env.PUBLIC ? join(process.env.PUBLIC, 'Documents') : undefined,
    publicDir,
    systemDriveProgramData,
    'C:\\ProgramData'
  ]
  const roots: string[] = []
  for (const candidate of candidates) {
    if (!candidate || hasNonAsciiCharacters(candidate) || roots.includes(candidate)) {
      continue
    }
    roots.push(candidate)
  }
  return roots
}

export function getSpeechModelCacheDirCandidates(
  requestedModelsDir: string
): SpeechModelCacheDir[] {
  if (process.platform !== 'win32' || !hasNonAsciiCharacters(requestedModelsDir)) {
    return [{ modelsDir: requestedModelsDir, migrationSourceDir: null }]
  }

  const requestedModelsDirHash = createHash('sha256')
    .update(resolve(requestedModelsDir))
    .digest('hex')
    .slice(0, WINDOWS_SAFE_CACHE_HASH_LENGTH)
  const candidates = getWindowsAsciiSharedDataRoots()
    .map((root) => join(root, 'Orca', 'speech-models', requestedModelsDirHash))
    .filter((modelsDir) => !hasNonAsciiCharacters(modelsDir))
    .map((modelsDir) => ({ modelsDir, migrationSourceDir: requestedModelsDir }))

  // Why: sherpa-onnx 1.12.x cannot load model files from non-ASCII Windows
  // paths. Try ASCII shared caches first, but keep the requested path as a
  // last fallback so cache setup failures do not prevent the app from opening.
  return [...candidates, { modelsDir: requestedModelsDir, migrationSourceDir: null }]
}

async function copyMissingCacheEntry(
  sourcePath: string,
  targetPath: string,
  depth: number,
  budget: SpeechModelCacheMigrationBudget
): Promise<void> {
  budget.claim(sourcePath, targetPath, depth)
  const sourceStat = await stat(sourcePath)
  if (sourceStat.isDirectory()) {
    await mkdir(targetPath, { recursive: true })
    const directory = await opendir(sourcePath, { bufferSize: 32 })
    for await (const entry of directory) {
      await copyMissingCacheEntry(
        join(sourcePath, entry.name),
        join(targetPath, entry.name),
        depth + 1,
        budget
      )
    }
    return
  }

  if (existsSync(targetPath)) {
    return
  }

  // Why: copy to a temp path and atomically rename so an interrupted migration
  // never leaves a truncated model file that passes existence-only validation.
  const tempPath = `${targetPath}.partial`
  await cp(sourcePath, tempPath, { force: true })
  await rename(tempPath, targetPath)
}

export async function migrateSpeechModelCacheIfNeeded(
  sourceDir: string | null,
  targetDir: string,
  limits: Partial<SpeechModelCacheMigrationLimits> = {}
): Promise<void> {
  if (!sourceDir || resolve(sourceDir) === resolve(targetDir) || !existsSync(sourceDir)) {
    return
  }

  try {
    const budget = new SpeechModelCacheMigrationBudget(limits)
    const directory = await opendir(sourceDir, { bufferSize: 32 })
    for await (const entry of directory) {
      await copyMissingCacheEntry(
        join(sourceDir, entry.name),
        join(targetDir, entry.name),
        1,
        budget
      )
    }
  } catch (error) {
    console.warn('[speech] Failed to migrate speech model cache to ASCII path:', error)
  }
}
