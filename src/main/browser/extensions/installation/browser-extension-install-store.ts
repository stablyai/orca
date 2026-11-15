import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { isChromeExtensionId } from '../../../../shared/browser/extensions/browser-extension-url'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'

const INSTALLED_FILE_NAME = 'installed.json'
const REMOVALS_FILE_NAME = 'uninstalled.json'

const installedExtensionSchema = z.object({
  id: z.string().refine(isChromeExtensionId),
  name: z.string(),
  version: z.string(),
  path: z.string(),
  source: z.enum(['webstore', 'unpacked']),
  iconPath: z.string().nullable(),
  permissions: z.array(z.string()),
  hostPermissions: z.array(z.string()),
  optionsPage: z.string().nullable(),
  installTime: z.number().int().nonnegative().optional()
})

/**
 * The installed list, shared by every local browser profile. Store installs live under
 * `<root>/<id>/<version>/`; unpacked extensions are referenced where the user keeps them and
 * loaded from Orca's copy under `<root>/unpacked/`.
 */
export class BrowserExtensionInstallStore {
  private cache: Map<string, InstalledBrowserExtension> | null = null
  private removals: Map<string, number> | null = null
  private maintenanceVersion = 0
  private readonly reserved = new Map<string, InstalledBrowserExtension>()

  get maintenanceRevision(): number {
    return this.maintenanceVersion
  }

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

  /** Monotonic uninstall markers survive reinstall and are shared by every Orca profile. */
  removalGenerations(): ReadonlyMap<string, number> {
    if (!this.removals) {
      const entries = new Map<string, number>()
      try {
        const raw: unknown = JSON.parse(
          readFileSync(join(this.rootDirectory, REMOVALS_FILE_NAME), 'utf8')
        )
        const parsed = z
          .record(z.string().refine(isChromeExtensionId), z.number().int().positive())
          .parse(raw)
        for (const [id, generation] of Object.entries(parsed)) {
          entries.set(id, generation)
        }
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error
        }
      }
      this.removals = entries
    }
    return this.removals
  }

  removalGeneration(extensionId: string): number {
    return this.removalGenerations().get(extensionId) ?? 0
  }

  private withInstallTime(
    extension: InstalledBrowserExtension,
    updated: boolean
  ): InstalledBrowserExtension {
    const entries = this.load()
    const previous = entries.get(extension.id)
    const latest = Math.max(0, ...[...entries.values()].map((entry) => entry.installTime ?? 0))
    const installTime = updated
      ? Math.max(Date.now(), latest + 1)
      : (extension.installTime ??
        (!previous || previous.version !== extension.version
          ? Math.max(Date.now(), latest + 1)
          : (previous.installTime ?? 0)))
    return installedExtensionSchema.parse({ ...extension, installTime })
  }

  /** A candidate's record while its first load runs; only `save` makes it installed. */
  reserve(extension: InstalledBrowserExtension): {
    record: InstalledBrowserExtension
    release: () => void
  } {
    const record = this.withInstallTime(extension, false)
    this.reserved.set(record.id, record)
    return {
      record,
      release: () => {
        if (this.reserved.get(record.id) === record) {
          this.reserved.delete(record.id)
          // Why: cleanup kept a failed candidate's data while reserved; the next sweep removes it.
          if (!this.load().has(record.id)) {
            this.maintenanceVersion++
          }
        }
      }
    }
  }

  /** Ids whose data cleanup must keep: installed, or a candidate whose first load is running. */
  retainedIds(): ReadonlySet<string> {
    return new Set([...this.load().keys(), ...this.reserved.keys()])
  }

  /** Precedence a native load runs under: its reserved candidate's, else the installed record's. */
  loadInstallTime(extensionId: string): number {
    return (this.reserved.get(extensionId) ?? this.get(extensionId))?.installTime ?? 0
  }

  save(extension: InstalledBrowserExtension, updated = false): InstalledBrowserExtension {
    const entries = this.load()
    const installed = this.withInstallTime(extension, updated)
    entries.set(extension.id, installed)
    this.persist(entries)
    this.maintenanceVersion++
    return installed
  }

  /** Forgets the extension and deletes the folders Orca owns (never the user's unpacked folder). */
  async remove(extensionId: string): Promise<InstalledBrowserExtension | null> {
    const entries = this.load()
    const existing = entries.get(extensionId)
    if (!existing) {
      return null
    }
    const removals = new Map(this.removalGenerations())
    removals.set(extensionId, (removals.get(extensionId) ?? 0) + 1)
    mkdirSync(this.rootDirectory, { recursive: true })
    const removalTarget = join(this.rootDirectory, REMOVALS_FILE_NAME)
    writeFileSync(`${removalTarget}.tmp`, JSON.stringify(Object.fromEntries(removals)))
    renameSync(`${removalTarget}.tmp`, removalTarget)
    this.removals = removals
    entries.delete(extensionId)
    this.persist(entries)
    this.maintenanceVersion++
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
    // Legacy list order was install order; persist it once so all profiles use the same precedence.
    let legacyTime = 0
    let migrated = false
    for (const [id, entry] of entries) {
      legacyTime = Math.max(legacyTime + 1, entry.installTime ?? 0)
      if (entry.installTime === undefined) {
        entries.set(id, { ...entry, installTime: legacyTime })
        migrated = true
      }
    }
    if (migrated) {
      this.persist(entries)
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
