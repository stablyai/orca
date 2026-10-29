import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { parse, stringify } from 'yaml'
import {
  LOCAL_BUILD_COMPATIBILITY_FILENAME,
  ORCA_APP_ID,
  parseLocalBuildCompatibility,
  type LocalBuildCompatibility
} from '../../shared/local-build-compatibility'
import { isValidAppVersion } from '../../shared/app-version'

const MAX_MANIFEST_BYTES = 256 * 1024
const MAX_COMPATIBILITY_BYTES = 64 * 1024
const MAX_UPDATE_FILES = 8
const MAX_ZIP_BYTES = 8 * 1024 * 1024 * 1024
const SAFE_ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9._ ()+-]*\.zip$/

type ManifestFile = {
  url: string
  sha512: string
  size?: number
}

export type LocalBuildCandidate = {
  version: string
  compatibility: LocalBuildCompatibility
  manifestContent: string
  artifacts: Map<string, { file: FileHandle; size: number }>
  close: () => Promise<void>
}

type LocalBuildCandidateLoaderOptions = {
  readCompatibility?: (zipFile: FileHandle) => Promise<LocalBuildCompatibility>
}

function parseManifestFile(value: unknown): ManifestFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The local update manifest contains an invalid file entry.')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.url !== 'string' ||
    !SAFE_ARTIFACT_NAME.test(record.url) ||
    basename(record.url) !== record.url ||
    typeof record.sha512 !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/.test(record.sha512) ||
    (record.size !== undefined && (!Number.isSafeInteger(record.size) || Number(record.size) <= 0))
  ) {
    throw new Error('The local update manifest contains an invalid file entry.')
  }
  return {
    url: record.url,
    sha512: record.sha512,
    ...(record.size === undefined ? {} : { size: Number(record.size) })
  }
}

function isZipManifestFile(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const url = (value as Record<string, unknown>).url
  return typeof url === 'string' && url.toLowerCase().endsWith('.zip')
}

function parseManifest(value: unknown): { version: string; files: ManifestFile[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The selected file is not a valid macOS update manifest.')
  }
  const record = value as Record<string, unknown>
  if (
    typeof record.version !== 'string' ||
    record.version.length === 0 ||
    record.version.length > 100 ||
    !isValidAppVersion(record.version) ||
    !Array.isArray(record.files) ||
    record.files.length === 0 ||
    record.files.length > MAX_UPDATE_FILES
  ) {
    throw new Error('The selected file is not a valid macOS update manifest.')
  }
  const zipFiles = record.files.filter(isZipManifestFile)
  if (zipFiles.length === 0) {
    throw new Error('The selected macOS update manifest does not contain a ZIP.')
  }
  return { version: record.version, files: zipFiles.map(parseManifestFile) }
}

async function hashFile(file: FileHandle): Promise<string> {
  const hash = createHash('sha512')
  await new Promise<void>((resolve, reject) => {
    const stream = file.createReadStream({ autoClose: false, start: 0 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return hash.digest('base64')
}

async function assertContainedRegularFile(rootPath: string, filePath: string): Promise<void> {
  const fileInfo = await lstat(filePath)
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) {
    throw new Error('Local update artifacts must be regular files, not links.')
  }
  const [resolvedRoot, resolvedFile] = await Promise.all([realpath(rootPath), realpath(filePath)])
  if (dirname(resolvedFile) !== resolvedRoot) {
    throw new Error('Local update artifacts must stay beside latest-mac.yml.')
  }
}

function extractCompatibility(zipFile: FileHandle): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/bin/unzip',
      ['-p', '/dev/fd/3', `Orca.app/Contents/Resources/${LOCAL_BUILD_COMPATIBILITY_FILENAME}`],
      { stdio: ['ignore', 'pipe', 'ignore', zipFile.fd] }
    )
    const chunks: Buffer[] = []
    let outputBytes = 0
    let outputError: Error | null = null
    const stdout = child.stdout
    if (!stdout) {
      child.kill()
      reject(new Error('Could not read compatibility metadata.'))
      return
    }
    stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_COMPATIBILITY_BYTES) {
        outputError = new Error('Compatibility metadata is too large.')
        child.kill()
        return
      }
      chunks.push(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (outputError) {
        reject(outputError)
      } else if (code !== 0) {
        reject(new Error(`unzip exited with status ${code ?? 'unknown'}.`))
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'))
      }
    })
  })
}

async function readCompatibility(zipFile: FileHandle): Promise<LocalBuildCompatibility> {
  let stdout: string
  try {
    stdout = await extractCompatibility(zipFile)
  } catch (error) {
    console.warn('[local-build] Could not read compatibility metadata:', error)
    throw new Error(
      'This build predates local switching or is missing its signed compatibility metadata.'
    )
  }
  try {
    return parseLocalBuildCompatibility(JSON.parse(stdout))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('The selected build has malformed compatibility metadata.')
    }
    throw error
  }
}

async function validateArtifact(
  rootPath: string,
  manifestFile: ManifestFile,
  manifestVersion: string,
  compatibilityReader: (zipFile: FileHandle) => Promise<LocalBuildCompatibility>
): Promise<{ compatibility: LocalBuildCompatibility; file: FileHandle; size: number }> {
  const filePath = join(rootPath, manifestFile.url)
  await assertContainedRegularFile(rootPath, filePath)
  const file = await open(
    filePath,
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
  )
  try {
    const fileStats = await file.stat()
    if (!fileStats.isFile() || fileStats.size <= 0 || fileStats.size > MAX_ZIP_BYTES) {
      throw new Error('The selected local build ZIP has an invalid size.')
    }
    if (manifestFile.size !== undefined && fileStats.size !== manifestFile.size) {
      throw new Error(`Size verification failed for ${manifestFile.url}.`)
    }
    if ((await hashFile(file)) !== manifestFile.sha512) {
      throw new Error(`SHA-512 verification failed for ${manifestFile.url}.`)
    }
    const compatibility = await compatibilityReader(file)
    if (compatibility.appId !== ORCA_APP_ID || compatibility.version !== manifestVersion) {
      throw new Error('The selected ZIP does not match its update manifest.')
    }
    return { compatibility, file, size: fileStats.size }
  } catch (error) {
    await file.close()
    throw error
  }
}

export async function loadLocalBuildCandidate(
  manifestPath: string,
  architecture: NodeJS.Architecture,
  options: LocalBuildCandidateLoaderOptions = {}
): Promise<LocalBuildCandidate> {
  if (basename(manifestPath) !== 'latest-mac.yml') {
    throw new Error('Select the latest-mac.yml generated by pn build:mac.')
  }
  await assertContainedRegularFile(dirname(manifestPath), manifestPath)
  const manifestFile = await open(
    manifestPath,
    constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)
  )
  let manifestText: string
  try {
    const manifestStats = await manifestFile.stat()
    if (
      !manifestStats.isFile() ||
      manifestStats.size <= 0 ||
      manifestStats.size > MAX_MANIFEST_BYTES
    ) {
      throw new Error('The selected update manifest is too large.')
    }
    manifestText = await manifestFile.readFile('utf8')
  } finally {
    await manifestFile.close()
  }
  const manifest = parseManifest(parse(manifestText, { maxAliasCount: 0 }))
  const rootPath = dirname(manifestPath)
  const compatibilityReader = options.readCompatibility ?? readCompatibility
  const validationResults = await Promise.allSettled(
    manifest.files.map((file) =>
      validateArtifact(rootPath, file, manifest.version, compatibilityReader)
    )
  )
  const validated = validationResults
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value)
  const failed = validationResults.find((result) => result.status === 'rejected')
  if (failed?.status === 'rejected') {
    await Promise.all(validated.map((entry) => entry.file.close()))
    throw failed.reason
  }
  const matching = validated
    .map((entry, index) => ({ ...entry, manifestFile: manifest.files[index] }))
    .filter((entry) => entry.compatibility.architecture === architecture)
  if (matching.length !== 1) {
    await Promise.all(validated.map((entry) => entry.file.close()))
    throw new Error(`The manifest must contain exactly one ${architecture} Orca ZIP.`)
  }
  const target = matching[0]
  await Promise.all(
    validated.filter((entry) => entry.file !== target.file).map((entry) => entry.file.close())
  )
  const sanitizedFile = {
    url: target.manifestFile.url,
    sha512: target.manifestFile.sha512,
    ...(target.manifestFile.size === undefined ? {} : { size: target.manifestFile.size })
  }
  return {
    version: manifest.version,
    compatibility: target.compatibility,
    manifestContent: stringify({
      version: manifest.version,
      files: [sanitizedFile],
      path: sanitizedFile.url,
      sha512: sanitizedFile.sha512
    }),
    artifacts: new Map([[target.manifestFile.url, { file: target.file, size: target.size }]]),
    close: async () => {
      await target.file.close()
    }
  }
}
