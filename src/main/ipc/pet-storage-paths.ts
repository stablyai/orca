import { app } from 'electron'
import { basename, join, normalize, sep } from 'node:path'

// Why: keep the legacy `sidekicks` folder so existing user-uploaded pets keep rendering after the product rename.
export function getPetsDir(): string {
  return join(app.getPath('userData'), 'sidekicks', 'custom')
}

export function isSafeId(id: string): boolean {
  // UUIDs only — canonical path-traversal gate; storage ids are always main-generated, never from manifest.id.
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
    // Bundle layout custom/<id>/<fileName>; fileName is the spritesheet basename — pet.json is main-only, never served.
    filePath = normalize(join(root, id, safeName))
    const bundleDir = normalize(join(root, id)) + sep
    if (!filePath.startsWith(bundleDir)) {
      return null
    }
    return filePath
  }
  // Legacy image layout custom/<id>.<ext>; filename must start with the id so the prefix check backstops the regex.
  if (!safeName.startsWith(`${id}.`)) {
    return null
  }
  filePath = normalize(join(root, safeName))
  if (!filePath.startsWith(root + sep)) {
    return null
  }
  return filePath
}
