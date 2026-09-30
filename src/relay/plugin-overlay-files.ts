import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { safeRemoveOverlay } from '../main/pty/overlay-mirror'

export function canOverwriteManagedExtension(path: string, marker: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(marker)
  } catch {
    return true
  }
}

export function writeManagedExtension(path: string, source: string, marker: string): boolean {
  if (!canOverwriteManagedExtension(path, marker)) {
    return false
  }
  writeFileSync(path, source)
  return true
}

export function writeOmoPrefillExtension(
  kind: string,
  extensionsDir: string,
  source: string | null,
  marker: string
): void {
  if (kind !== 'omo' || !source) {
    return
  }
  const prefillPath = join(extensionsDir, 'orca-prefill.ts')
  if (canOverwriteManagedExtension(prefillPath, marker)) {
    writeFileSync(prefillPath, source)
  }
}

export function clearPluginOverlayDirs(
  id: string,
  roots: readonly string[],
  safeName: string
): void {
  for (const root of roots) {
    try {
      safeRemoveOverlay(join(root, safeName), root)
    } catch (err) {
      process.stderr.write(
        `[plugin-overlay] failed to remove overlay dir ${join(root, safeName)}: ${err instanceof Error ? err.message : String(err)}\n`
      )
    }
  }
}
