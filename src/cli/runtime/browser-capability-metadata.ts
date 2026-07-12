import { chmodSync, mkdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'

export function writeBrowserCapabilityMetadata(
  outputDirectory: string,
  sourceDirectory: string,
  source: RuntimeMetadata,
  authToken: string
): string {
  const directory = resolve(outputDirectory)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (realpathSync(directory) === realpathSync(sourceDirectory)) {
    throw new Error('Capability output must not overwrite the active Orca runtime metadata')
  }
  const destination = getRuntimeMetadataPath(directory)
  const temporary = `${destination}.${process.pid}.tmp`
  writeFileSync(
    temporary,
    `${JSON.stringify({ ...source, authToken, authScope: 'browser-capability' }, null, 2)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600
    }
  )
  renameSync(temporary, destination)
  try {
    chmodSync(destination, 0o600)
  } catch {
    // Windows does not implement POSIX modes. The file remains scoped by the
    // user's profile directory and contains only a short-lived capability.
  }
  return destination
}
