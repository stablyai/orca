import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { SERVE_TEMP_DIRECTORY_ENV } from '../../shared/serve-supervision'

export { SERVE_TEMP_DIRECTORY_ENV } from '../../shared/serve-supervision'

type ServeTempDirectoryOptions = {
  env?: NodeJS.ProcessEnv
  defaultDirectory?: () => string
  createProbeDirectory?: (prefix: string) => string
  writeProbeFile?: (path: string) => void
}

export class ServeTempDirectoryError extends Error {
  readonly code = 'serve_temp_unavailable'
  readonly causeCode: string | null

  constructor(directory: string, causeCode: string | null, detail: string) {
    super(
      `Orca serve temporary directory is unavailable at ${directory}: ${detail}. ` +
        `Set ${SERVE_TEMP_DIRECTORY_ENV} to an absolute writable directory on a filesystem with free space.`
    )
    this.name = 'ServeTempDirectoryError'
    this.causeCode = causeCode
  }
}

export function prepareServeTempDirectory(options: ServeTempDirectoryOptions = {}): string {
  const env = options.env ?? process.env
  const configured = env[SERVE_TEMP_DIRECTORY_ENV]?.trim()
  const directory = configured || (options.defaultDirectory ?? tmpdir)()

  if (!isAbsolute(directory)) {
    throw new ServeTempDirectoryError(directory, null, 'the configured path must be absolute')
  }

  const normalized = resolve(directory)
  let probeDirectory: string | null = null
  try {
    mkdirSync(normalized, { recursive: true, mode: 0o700 })
    probeDirectory = (options.createProbeDirectory ?? mkdtempSync)(
      join(normalized, '.orca-serve-probe-')
    )
    const writeProbeFile = options.writeProbeFile ?? defaultWriteProbeFile
    writeProbeFile(join(probeDirectory, 'write-probe'))
    rmSync(probeDirectory, { recursive: true })
    return normalized
  } catch (error) {
    if (probeDirectory) {
      try {
        rmSync(probeDirectory, { recursive: true, force: true })
      } catch {
        // The primary error below is more actionable than cleanup failure.
      }
    }
    const causeCode = (error as NodeJS.ErrnoException).code ?? null
    const detail =
      causeCode === 'ENOSPC' ? 'no space left on the filesystem' : safeErrorMessage(error)
    throw new ServeTempDirectoryError(normalized, causeCode, detail)
  }
}

function defaultWriteProbeFile(path: string): void {
  const descriptor = openSync(path, 'wx', 0o600)
  try {
    writeSync(descriptor, 'orca')
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

export function applyServeTempDirectory(
  env: NodeJS.ProcessEnv,
  directory: string,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, [SERVE_TEMP_DIRECTORY_ENV]: directory }
  if (platform === 'win32') {
    result.TEMP = directory
    result.TMP = directory
  } else {
    result.TMPDIR = directory
  }
  return result
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  return 'the directory could not be created or written'
}
