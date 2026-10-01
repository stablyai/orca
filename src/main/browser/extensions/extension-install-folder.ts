import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** An extension installed on disk, loaded or not. */
export type InstalledExtension = { id: string; path: string; manifest: Record<string, unknown> }

const EXTENSION_ID = /^[a-p]{32}$/
const SETTINGS_FILE = 'orca-extension-settings.json'

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] || 0) - (right[i] || 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

async function readManifest(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'))
    return typeof parsed === 'object' && parsed !== null
      ? Object.fromEntries(Object.entries(parsed))
      : null
  } catch {
    return null
  }
}

/**
 * The Chrome Web Store installs, one per extension: the store keeps each under
 * `<folder>/<id>/<version>/`, and after an update the newest version is the live one.
 */
export async function readInstalledExtensions(folder: string): Promise<InstalledExtension[]> {
  const ids = await readdir(folder).catch(() => [])
  const installs = await Promise.all(
    ids
      .filter((id) => EXTENSION_ID.test(id))
      .map(async (id) => {
        const versions = await readdir(join(folder, id)).catch(() => [])
        let newest: InstalledExtension | null = null
        for (const version of versions) {
          const path = join(folder, id, version)
          const manifest = await readManifest(path)
          const number = typeof manifest?.version === 'string' ? manifest.version : null
          const newestNumber = String(newest?.manifest.version ?? '0')
          if (manifest && number && (!newest || compareVersions(number, newestNumber) > 0)) {
            newest = { id, path, manifest }
          }
        }
        return newest
      })
  )
  return installs.filter((install): install is InstalledExtension => install !== null)
}

/** Ids of installed extensions the user turned off. */
export async function readDisabledExtensions(folder: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(folder, SETTINGS_FILE), 'utf8'))
    const disabled: unknown = Reflect.get(Object(parsed), 'disabled')
    return new Set(
      Array.isArray(disabled) ? disabled.filter((id): id is string => typeof id === 'string') : []
    )
  } catch {
    return new Set()
  }
}

export async function writeDisabledExtensions(
  folder: string,
  disabled: Set<string>
): Promise<void> {
  await writeFile(join(folder, SETTINGS_FILE), JSON.stringify({ disabled: [...disabled] }, null, 2))
}
