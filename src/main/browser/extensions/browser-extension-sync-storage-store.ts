import { app } from 'electron'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'

const DIRECTORY_NAME = 'sync-storage'
const PERSIST_DELAY_MS = 250

export type BrowserExtensionSyncItems = Record<string, unknown>

function isItems(value: unknown): value is BrowserExtensionSyncItems {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * chrome.storage.sync items per browser profile and extension, kept on this machine the way
 * Chrome keeps them for a user who is not signed in. One file per extension, so a write rewrites
 * only that extension's items (up to 100 KB).
 */
export class BrowserExtensionSyncStorageStore {
  /** Profile → extension → items. */
  private readonly cache = new Map<string, Map<string, BrowserExtensionSyncItems>>()
  /** Profile → extensions whose items are not on disk yet. */
  private readonly dirty = new Map<string, Set<string>>()
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly rootDirectory: string) {}

  read(profileId: string, extensionId: string): BrowserExtensionSyncItems {
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

  write(profileId: string, extensionId: string, items: BrowserExtensionSyncItems): void {
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
      profileDirectories = readdirSync(join(this.rootDirectory, DIRECTORY_NAME))
    } catch {
      return
    }
    for (const directory of profileDirectories) {
      rmSync(join(this.rootDirectory, DIRECTORY_NAME, directory, this.fileName(extensionId)), {
        force: true
      })
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
      this.dirty.delete(profileId)
      const directory = this.profileDirectory(profileId)
      mkdirSync(directory, { recursive: true })
      for (const extensionId of extensionIds) {
        const target = join(directory, this.fileName(extensionId))
        const items = this.cache.get(profileId)?.get(extensionId) ?? {}
        writeFileDurableSync(durableWriteTempPath(target), target, JSON.stringify(items))
      }
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

  private load(profileId: string, extensionId: string): BrowserExtensionSyncItems {
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
    return join(this.rootDirectory, DIRECTORY_NAME, encodeURIComponent(profileId))
  }

  private fileName(extensionId: string): string {
    return `${encodeURIComponent(extensionId)}.json`
  }
}

let syncStorageStore: BrowserExtensionSyncStorageStore | null = null

export function getBrowserExtensionSyncStorageStore(): BrowserExtensionSyncStorageStore {
  if (!syncStorageStore) {
    const store = new BrowserExtensionSyncStorageStore(
      join(app.getPath('userData'), 'browser-extensions')
    )
    app.on('will-quit', () => store.flush())
    syncStorageStore = store
  }
  return syncStorageStore
}
