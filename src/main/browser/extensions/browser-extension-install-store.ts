import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { isChromeExtensionId } from '../../../shared/browser-extension-url'
import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'

const INSTALLED_FILE_NAME = 'installed.json'

const installedExtensionSchema = z.object({
  id: z.string().refine(isChromeExtensionId),
  name: z.string(),
  version: z.string(),
  path: z.string(),
  source: z.enum(['webstore', 'unpacked']),
  iconPath: z.string().nullable(),
  permissions: z.array(z.string()),
  hostPermissions: z.array(z.string()),
  optionsPage: z.string().nullable()
})

/**
 * The installed list, shared by every local browser profile. Store installs live under
 * `<root>/<id>/<version>/`; unpacked extensions are referenced where the user keeps them and
 * loaded from Orca's copy under `<root>/unpacked/`.
 */
export class BrowserExtensionInstallStore {
  private cache: Map<string, InstalledBrowserExtension> | null = null

  constructor(private readonly rootDirectory: string) {}

  get root(): string {
    return this.rootDirectory
  }

  /** Where a store install of this version unpacks. */
  installDirectory(extensionId: string, version: string): string {
    if (!isChromeExtensionId(extensionId) || !/^[\d.]+$/.test(version)) {
      throw new Error('Invalid extension id or version')
    }
    return join(this.rootDirectory, extensionId, version)
  }

  /** Orca's copy of an unpacked folder, stable per folder so its id survives restarts. */
  unpackedCopyDirectory(sourceDirectory: string): string {
    const digest = createHash('sha256').update(resolve(sourceDirectory)).digest('hex')
    return join(this.rootDirectory, 'unpacked', digest.slice(0, 32))
  }

  list(): InstalledBrowserExtension[] {
    return [...this.load().values()]
  }

  get(extensionId: string): InstalledBrowserExtension | null {
    return this.load().get(extensionId) ?? null
  }

  save(extension: InstalledBrowserExtension): void {
    const entries = this.load()
    entries.set(extension.id, installedExtensionSchema.parse(extension))
    this.persist(entries)
  }

  /** Forgets the extension and deletes the folders Orca owns (never the user's unpacked folder). */
  async remove(extensionId: string): Promise<InstalledBrowserExtension | null> {
    const entries = this.load()
    const existing = entries.get(extensionId)
    if (!existing) {
      return null
    }
    entries.delete(extensionId)
    this.persist(entries)
    const ownedDirectory =
      existing.source === 'webstore'
        ? join(this.rootDirectory, extensionId)
        : this.unpackedCopyDirectory(existing.path)
    const rel = relative(resolve(this.rootDirectory), resolve(ownedDirectory))
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      await rm(ownedDirectory, { recursive: true, force: true, maxRetries: 3 })
    }
    return existing
  }

  private load(): Map<string, InstalledBrowserExtension> {
    if (this.cache) {
      return this.cache
    }
    const entries = new Map<string, InstalledBrowserExtension>()
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(this.rootDirectory, INSTALLED_FILE_NAME), 'utf8')
      )
      for (const candidate of Array.isArray(raw) ? raw : []) {
        const parsed = installedExtensionSchema.safeParse(candidate)
        if (parsed.success) {
          entries.set(parsed.data.id, parsed.data)
        }
      }
    } catch {
      // Missing or unreadable list: start empty.
    }
    this.cache = entries
    return entries
  }

  // Why: write-temp-then-rename so a crash mid-write cannot corrupt the list.
  private persist(entries: Map<string, InstalledBrowserExtension>): void {
    mkdirSync(this.rootDirectory, { recursive: true })
    const target = join(this.rootDirectory, INSTALLED_FILE_NAME)
    writeFileSync(`${target}.tmp`, JSON.stringify([...entries.values()], null, 2))
    renameSync(`${target}.tmp`, target)
  }
}

let installStore: BrowserExtensionInstallStore | null = null

export function getBrowserExtensionInstallStore(): BrowserExtensionInstallStore {
  installStore ??= new BrowserExtensionInstallStore(
    join(app.getPath('userData'), 'browser-extensions')
  )
  return installStore
}
