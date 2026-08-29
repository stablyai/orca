import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MARKER_NAME = '.materialized.json'

export type DaemonHostMaterializationMarker = {
  version: string
  completedAt: string
  entryRelPath: string
  windowsProcessTreeSha256: string
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex')
}

export function readDaemonHostMaterializationMarker(
  hostDir: string
): DaemonHostMaterializationMarker | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(hostDir, MARKER_NAME), 'utf8')
    ) as Partial<DaemonHostMaterializationMarker>
    if (
      typeof parsed.version === 'string' &&
      typeof parsed.entryRelPath === 'string' &&
      typeof parsed.windowsProcessTreeSha256 === 'string'
    ) {
      return {
        version: parsed.version,
        completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : '',
        entryRelPath: parsed.entryRelPath,
        windowsProcessTreeSha256: parsed.windowsProcessTreeSha256
      }
    }
  } catch {
    // Missing/corrupt marker is not a valid materialization.
  }
  return null
}

export function writeDaemonHostMaterializationMarker(
  hostDir: string,
  marker: Omit<DaemonHostMaterializationMarker, 'windowsProcessTreeSha256'>,
  windowsProcessTreeAddonPath: string
): void {
  writeFileSync(
    join(hostDir, MARKER_NAME),
    JSON.stringify({
      ...marker,
      windowsProcessTreeSha256: sha256File(windowsProcessTreeAddonPath)
    } satisfies DaemonHostMaterializationMarker)
  )
}

export function relocatedWindowsProcessTreeMatches(args: {
  sourcePath: string
  relocatedPath: string
  expectedSha256: string
}): boolean {
  try {
    const sourceHash = sha256File(args.sourcePath)
    return args.expectedSha256 === sourceHash && sha256File(args.relocatedPath) === sourceHash
  } catch {
    return false
  }
}
