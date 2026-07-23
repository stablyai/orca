import { opendirSync } from 'node:fs'
import { join } from 'node:path'

export const NVM_VERSION_DISCOVERY_MAX_ENTRIES = 4_096
export const NVM_VERSION_DISCOVERY_MAX_RETAINED_NAME_BYTES = 1024 * 1024

export type NvmVersionDiscoveryLimits = {
  maxEntries: number
  maxRetainedNameBytes: number
}

function parseVersionSegment(raw: string): number[] {
  return raw
    .replace(/^v/i, '')
    .split('.')
    .map((segment) => Number.parseInt(segment, 10))
    .map((segment) => (Number.isFinite(segment) ? segment : 0))
}

function compareVersionDesc(left: string, right: string): number {
  const leftParts = parseVersionSegment(left)
  const rightParts = parseVersionSegment(right)
  const length = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < length; index += 1) {
    const delta = (rightParts[index] ?? 0) - (leftParts[index] ?? 0)
    if (delta !== 0) {
      return delta
    }
  }

  return right.localeCompare(left)
}

function resolveLimit(requested: number | undefined, maximum: number, name: string): number {
  if (requested === undefined) {
    return maximum
  }
  if (!Number.isSafeInteger(requested) || requested < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return Math.min(requested, maximum)
}

function closeNvmVersionsDirectory(directory: ReturnType<typeof opendirSync>): void {
  try {
    directory.closeSync()
  } catch {
    // The OS may already have closed a fully consumed directory stream.
  }
}

export function discoverNvmVersionBinDirectories(
  homePath: string,
  requestedLimits: Partial<NvmVersionDiscoveryLimits> = {}
): string[] {
  const maxEntries = resolveLimit(
    requestedLimits.maxEntries,
    NVM_VERSION_DISCOVERY_MAX_ENTRIES,
    'maxEntries'
  )
  const maxRetainedNameBytes = resolveLimit(
    requestedLimits.maxRetainedNameBytes,
    NVM_VERSION_DISCOVERY_MAX_RETAINED_NAME_BYTES,
    'maxRetainedNameBytes'
  )
  const versionsDir = join(homePath, '.nvm', 'versions', 'node')
  let directory: ReturnType<typeof opendirSync>
  try {
    directory = opendirSync(versionsDir, { bufferSize: 32 })
  } catch {
    return []
  }

  const versionNames: string[] = []
  let scannedEntries = 0
  let retainedNameBytes = 0
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      scannedEntries += 1
      if (scannedEntries > maxEntries) {
        return []
      }
      if (!entry.isDirectory()) {
        continue
      }
      retainedNameBytes += Buffer.byteLength(entry.name, 'utf8')
      if (retainedNameBytes > maxRetainedNameBytes) {
        return []
      }
      versionNames.push(entry.name)
    }
  } finally {
    closeNvmVersionsDirectory(directory)
  }

  return versionNames
    .sort(compareVersionDesc)
    .map((versionName) => join(versionsDir, versionName, 'bin'))
}
