import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  durableWriteTempPath,
  writeFileDurableIfCurrent
} from '../../../filesystem/durable-file-write'
import {
  deleteSweptDocuments,
  documentFileName,
  documentProfileDirectory,
  sweepCovers,
  type Sweep,
  type SweepScope
} from './browser-extension-profile-document-sweeps'

const SYNC_STORAGE_DIRECTORY = 'sync-storage'

const PERSIST_DELAY_MS = 250

export type BrowserExtensionProfileDocumentItems = Record<string, unknown>

function isItems(value: unknown): value is BrowserExtensionProfileDocumentItems {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A forget after the final save didn't delete anything, so its caller must not record it as done. */
function closedError(): Promise<void> {
  const rejected = Promise.reject(new Error('Extension storage is closed for quit'))
  rejected.catch(() => {})
  return rejected
}

const storesToCloseOnQuit = new Set<BrowserExtensionProfileDocumentStore>()
let quitClosing = false

/** Production stores join the final save on quit; one created after it starts is closed at once. */
export function closeBrowserExtensionProfileDocumentStoreOnQuit(
  store: BrowserExtensionProfileDocumentStore
): void {
  storesToCloseOnQuit.add(store)
  if (quitClosing) {
    void store.close()
  }
}

/** Final save of every production store this run created; never rejects. */
export function closeBrowserExtensionProfileDocumentStores(): Promise<void> {
  quitClosing = true
  return Promise.allSettled([...storesToCloseOnQuit].map((store) => store.close())).then(() => {})
}

/**
 * Memory is the source of truth; disk work (writes and forget deletes, in request order) runs off
 * the main thread, one pass at a time, because durable writes fsync twice per file.
 */
export class BrowserExtensionProfileDocumentStore {
  /** Profile → extension → items. */
  private readonly cache = new Map<string, Map<string, BrowserExtensionProfileDocumentItems>>()
  /** Profile → extensions whose items are not on disk yet. */
  private readonly dirty = new Map<string, Set<string>>()
  /** Forgets not on disk yet, oldest first; a running pass keeps its sweeps here until done. */
  private sweeps: Sweep[] = []
  private timer: NodeJS.Timeout | null = null
  private running: Promise<boolean> | null = null
  private passRequested = false
  private closed = false

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
    // Closed for quit: changing memory now would veto the final save of earlier writes.
    if (this.closed) {
      return
    }
    this.read(profileId, extensionId)
    this.cache.get(profileId)?.set(extensionId, items)
    this.markDirty(profileId, extensionId)
    this.schedulePersist()
  }

  /** Settles once the files are deleted; memory forgets at once. */
  forgetExtension(extensionId: string): Promise<void> {
    if (this.closed) {
      return closedError()
    }
    for (const byExtension of this.cache.values()) {
      byExtension.delete(extensionId)
    }
    for (const dirty of this.dirty.values()) {
      dirty.delete(extensionId)
    }
    return this.queueSweep({ kind: 'extension', extensionId })
  }

  forgetProfileExtension(profileId: string, extensionId: string): Promise<void> {
    if (this.closed) {
      return closedError()
    }
    this.cache.get(profileId)?.delete(extensionId)
    this.dirty.get(profileId)?.delete(extensionId)
    return this.queueSweep({ kind: 'profileExtension', profileId, extensionId })
  }

  /** Drops one profile's items of every extension not in `extensionIds`. */
  forgetExtensionsExcept(profileId: string, extensionIds: ReadonlySet<string>): Promise<void> {
    if (this.closed) {
      return closedError()
    }
    const cached = this.cache.get(profileId)
    for (const extensionId of cached?.keys() ?? []) {
      if (!extensionIds.has(extensionId)) {
        cached?.delete(extensionId)
        this.dirty.get(profileId)?.delete(extensionId)
      }
    }
    return this.queueSweep({
      kind: 'profileExcept',
      profileId,
      extensionIds: new Set(extensionIds)
    })
  }

  forgetProfile(profileId: string): Promise<void> {
    if (this.closed) {
      return closedError()
    }
    this.cache.delete(profileId)
    this.dirty.delete(profileId)
    return this.queueSweep({ kind: 'profile', profileId })
  }

  /** Saves what is pending; stops early only if a pass that tried work saved nothing (e.g. disk full). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (;;) {
      while (this.running) {
        await this.running
      }
      if (!this.hasPendingWork() || !(await this.runPass())) {
        return
      }
    }
  }

  /** Final save on quit; later writes are ignored and forgets refused, as after the old last quit save. */
  close(): Promise<void> {
    this.closed = true
    return this.flush()
  }

  private queueSweep(scope: SweepScope): Promise<void> {
    let settle!: Sweep['settle']
    const done = new Promise<void>((resolve, reject) => {
      settle = (error) => (error === undefined ? resolve() : reject(error))
    })
    // Callers that don't await still get the deletion; only the first failure is reported.
    done.catch(() => {})
    this.sweeps.push({ scope, done, settle })
    // Callers wait for the delete, so don't debounce it.
    void this.runPass()
    return done
  }

  private markDirty(profileId: string, extensionId: string): void {
    const dirty = this.dirty.get(profileId) ?? new Set()
    dirty.add(extensionId)
    this.dirty.set(profileId, dirty)
  }

  private hasPendingWork(): boolean {
    return this.sweeps.length > 0 || [...this.dirty.values()].some((ids) => ids.size > 0)
  }

  // Why debounce: extensions often write settings key by key in a burst.
  private schedulePersist(): void {
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.runPass()
    }, PERSIST_DELAY_MS)
  }

  /** One pass at a time; a request during a pass runs one more pass after it. Resolves false when nothing succeeded. */
  private runPass(): Promise<boolean> {
    if (this.running) {
      this.passRequested = true
      return this.running
    }
    this.running = this.persist().finally(() => {
      this.running = null
      if (this.passRequested) {
        this.passRequested = false
        void this.runPass()
      }
    })
    return this.running
  }

  private async persist(): Promise<boolean> {
    let progressed = false
    let failure: unknown = null
    // Take this pass's work in one step: a forget dropped every earlier dirty key it covers, so these
    // documents were all written after the queued sweeps, which therefore run first.
    const sweeps = [...this.sweeps]
    const jobs: {
      profileId: string
      extensionId: string
      items: BrowserExtensionProfileDocumentItems
    }[] = []
    for (const [profileId, extensionIds] of this.dirty) {
      for (const extensionId of extensionIds) {
        const items = this.cache.get(profileId)?.get(extensionId)
        if (items) {
          jobs.push({ profileId, extensionId, items })
        }
      }
    }
    this.dirty.clear()
    const deleted = new Set<Sweep>()
    for (const sweep of sweeps) {
      try {
        await deleteSweptDocuments(sweep.scope, this.storageDirectory())
        deleted.add(sweep)
        sweep.settle()
        progressed = true
      } catch (error) {
        sweep.settle(error)
        failure = error
      }
    }
    this.sweeps = this.sweeps.filter((sweep) => !deleted.has(sweep))
    for (const { profileId, extensionId, items } of jobs) {
      // A newer write or a forget replaces the cached document; that write or delete owns the file.
      const isCurrent = () => this.cache.get(profileId)?.get(extensionId) === items
      if (!isCurrent()) {
        continue
      }
      // Written after a forget whose delete failed: keep the delete first.
      if (this.sweeps.some((sweep) => sweepCovers(sweep.scope, profileId, extensionId))) {
        this.markDirty(profileId, extensionId)
        continue
      }
      const directory = this.profileDirectory(profileId)
      const target = join(directory, this.fileName(extensionId))
      try {
        await mkdir(directory, { recursive: true })
        await writeFileDurableIfCurrent(
          durableWriteTempPath(target),
          target,
          JSON.stringify(items),
          isCurrent
        )
        progressed = true
      } catch (error) {
        failure = error
        if (isCurrent()) {
          this.markDirty(profileId, extensionId)
        }
      }
    }
    if (failure !== null) {
      console.warn('[browser-extensions] Could not save extension storage:', failure)
    }
    return progressed || failure === null
  }

  private load(profileId: string, extensionId: string): BrowserExtensionProfileDocumentItems {
    // A queued forget will delete this file; don't bring its items back meanwhile.
    if (this.sweeps.some((sweep) => sweepCovers(sweep.scope, profileId, extensionId))) {
      return {}
    }
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(this.profileDirectory(profileId), this.fileName(extensionId)), 'utf8')
      )
      return isItems(raw) ? raw : {}
    } catch {
      return {}
    }
  }

  private storageDirectory(): string {
    return join(this.rootDirectory, this.directoryName)
  }

  private profileDirectory(profileId: string): string {
    return documentProfileDirectory(this.storageDirectory(), profileId)
  }

  private fileName(extensionId: string): string {
    return documentFileName(extensionId)
  }
}
