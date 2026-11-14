import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isChromeExtensionId } from '../../../../shared/browser/extensions/browser-extension-url'
import { durableWriteTempPath, writeFileDurableSync } from '../../../filesystem/durable-file-write'

const SYNC_STORAGE_DIRECTORY = 'sync-storage'

const PERSIST_DELAY_MS = 250

export type BrowserExtensionProfileDocumentItems = Record<string, unknown>

function isItems(value: unknown): value is BrowserExtensionProfileDocumentItems {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export class BrowserExtensionProfileDocumentStore {
  /** Profile → extension → items. */
  private readonly cache = new Map<string, Map<string, BrowserExtensionProfileDocumentItems>>()
  /** Profile → extensions whose items are not on disk yet. */
  private readonly dirty = new Map<string, Set<string>>()
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly rootDirectory: string,
    /** declarativeNetRequest state reuses this store under its own directory. */
    private readonly directoryName = SYNC_STORAGE_DIRECTORY
  ) {}

  read(profileId: string, extensionId: string): BrowserExtensionProfileDocumentItems {
    let byExtension = this.cache.get(profileId)
    if (!byExtension) {
      byExtension = new Map()
      this.cache.set(profileId, byExtension)
    }
    let items = byExtension.get(extensionId)
    if (!items) {
      items = this.load(profileId, extensionId)
      byExtension.set(extensionId, items)
    }
    return items
  }

  write(profileId: string, extensionId: string, items: BrowserExtensionProfileDocumentItems): void {
    this.read(profileId, extensionId)
    this.cache.get(profileId)?.set(extensionId, items)
    const dirty = this.dirty.get(profileId) ?? new Set()
    dirty.add(extensionId)
    this.dirty.set(profileId, dirty)
    this.schedulePersist()
  }

  forgetExtension(extensionId: string): void {
    for (const byExtension of this.cache.values()) {
      byExtension.delete(extensionId)
    }
    for (const dirty of this.dirty.values()) {
      dirty.delete(extensionId)
    }
    let profileDirectories: string[]
    try {
      profileDirectories = readdirSync(join(this.rootDirectory, this.directoryName))
    } catch {
      return
    }
    for (const directory of profileDirectories) {
      rmSync(join(this.rootDirectory, this.directoryName, directory, this.fileName(extensionId)), {
        force: true
      })
    }
  }

  forgetProfileExtension(profileId: string, extensionId: string): void {
    this.cache.get(profileId)?.delete(extensionId)
    this.dirty.get(profileId)?.delete(extensionId)
    rmSync(join(this.profileDirectory(profileId), this.fileName(extensionId)), { force: true })
  }

  /** Drops one profile's items of every extension not in `extensionIds`. */
  forgetExtensionsExcept(profileId: string, extensionIds: ReadonlySet<string>): void {
    const cached = this.cache.get(profileId)
    for (const extensionId of cached?.keys() ?? []) {
      if (!extensionIds.has(extensionId)) {
        cached?.delete(extensionId)
        this.dirty.get(profileId)?.delete(extensionId)
      }
    }
    let files: string[]
    try {
      files = readdirSync(this.profileDirectory(profileId))
    } catch {
      return
    }
    for (const file of files) {
      const extensionId = file.replace(/\.json$/, '')
      if (isChromeExtensionId(extensionId) && !extensionIds.has(extensionId)) {
        rmSync(join(this.profileDirectory(profileId), file), { force: true })
      }
    }
  }

  forgetProfile(profileId: string): void {
    this.cache.delete(profileId)
    this.dirty.delete(profileId)
    rmSync(this.profileDirectory(profileId), { recursive: true, force: true })
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const [profileId, extensionIds] of this.dirty) {
      const directory = this.profileDirectory(profileId)
      mkdirSync(directory, { recursive: true })
      for (const extensionId of extensionIds) {
        const target = join(directory, this.fileName(extensionId))
        const items = this.cache.get(profileId)?.get(extensionId) ?? {}
        writeFileDurableSync(durableWriteTempPath(target), target, JSON.stringify(items))
        extensionIds.delete(extensionId)
      }
      this.dirty.delete(profileId)
    }
  }

  // Why debounce: extensions often write settings key by key in a burst.
  private schedulePersist(): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        this.flush()
      } catch (error) {
        console.warn('[browser-extensions] Could not save extension sync storage:', error)
      }
    }, PERSIST_DELAY_MS)
  }

  private load(profileId: string, extensionId: string): BrowserExtensionProfileDocumentItems {
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(this.profileDirectory(profileId), this.fileName(extensionId)), 'utf8')
      )
      return isItems(raw) ? raw : {}
    } catch {
      return {}
    }
  }

  private profileDirectory(profileId: string): string {
    return join(this.rootDirectory, this.directoryName, encodeURIComponent(profileId))
  }

  private fileName(extensionId: string): string {
    return `${encodeURIComponent(extensionId)}.json`
  }
}
