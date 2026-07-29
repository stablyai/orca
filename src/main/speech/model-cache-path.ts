import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export type SpeechModelCacheDir = {
  modelsDir: string
  migrationSourceDir: string | null
}

const WINDOWS_SAFE_CACHE_HASH_LENGTH = 16

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

async function copyMissingCacheEntry(sourcePath: string, targetPath: string): Promise<void> {
  const sourceStat = await stat(sourcePath)
  if (sourceStat.isDirectory()) {
    await mkdir(targetPath, { recursive: true })
    for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
      await copyMissingCacheEntry(join(sourcePath, entry.name), join(targetPath, entry.name))
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
  targetDir: string
): Promise<void> {
  if (!sourceDir || resolve(sourceDir) === resolve(targetDir) || !existsSync(sourceDir)) {
    return
  }

  try {
    for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
      await copyMissingCacheEntry(join(sourceDir, entry.name), join(targetDir, entry.name))
    }
  } catch (error) {
    console.warn('[speech] Failed to migrate speech model cache to ASCII path:', error)
  }
}
