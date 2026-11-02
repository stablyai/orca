import { app } from 'electron'
import { basename, join, normalize, sep } from 'node:path'

// Preserve uploaded pets across the sidekicks-to-pets rename.
export function getPetsDir(): string {
  return join(app.getPath('userData'), 'sidekicks', 'custom')
}

export function isSafeId(id: string): boolean {
  // Storage IDs are main-generated UUIDs, never manifest IDs.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

export function resolvePetFile(
  id: string,
  fileName: string,
  kind: 'image' | 'bundle'
): string | null {
  if (!isSafeId(id)) {
    return null
  }
  const safeName = basename(fileName)
  const root = normalize(getPetsDir())
  let filePath: string
  if (kind === 'bundle') {
    // Serve only the spritesheet from bundle storage; pet.json remains main-only.
    filePath = normalize(join(root, id, safeName))
    const bundleDir = normalize(join(root, id)) + sep
    if (!filePath.startsWith(bundleDir)) {
      return null
    }
    return filePath
  }
  // Legacy images use custom/<id>.<ext>; the prefix check reinforces filename validation.
  if (!safeName.startsWith(`${id}.`)) {
    return null
  }
  filePath = normalize(join(root, safeName))
  if (!filePath.startsWith(root + sep)) {
    return null
  }
  return filePath
}
