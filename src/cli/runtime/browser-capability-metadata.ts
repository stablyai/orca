import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getRuntimeMetadataPath, type RuntimeMetadata } from '../../shared/runtime-bootstrap'

export function writeBrowserCapabilityMetadata(
  outputDirectory: string,
  source: RuntimeMetadata,
  authToken: string
): string {
  const directory = resolve(outputDirectory)
  const destination = getRuntimeMetadataPath(directory)
  const temporary = `${destination}.${process.pid}.tmp`
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
  writeFileSync(temporary, `${JSON.stringify({ ...source, authToken }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  renameSync(temporary, destination)
  try {
    chmodSync(destination, 0o600)
  } catch {
    // Windows does not implement POSIX modes. The file remains scoped by the
    // user's profile directory and contains only a short-lived capability.
  }
  return destination
}
