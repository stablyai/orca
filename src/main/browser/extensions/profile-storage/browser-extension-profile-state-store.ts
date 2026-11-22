import { readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CoalescingFileWriter } from '../../../filesystem/coalescing-file-writer'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  writeFileDurable
} from '../../../filesystem/durable-file-write'
import { getBrowserExtensionProfileDataDirectory } from './browser-extension-profile-data-directory'

const STATE_FILE_NAME = 'profile-state.json'
const PERSIST_DELAY_MS = 250

const contextMenuItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  parentId: z.union([z.string(), z.number()]).optional(),
  type: z.enum(['normal', 'checkbox', 'radio', 'separator']),
  title: z.string().optional(),
  checked: z.boolean().optional(),
  contexts: z.array(z.string()),
  documentUrlPatterns: z.array(z.string()).optional(),
  targetUrlPatterns: z.array(z.string()).optional(),
  enabled: z.boolean(),
  visible: z.boolean()
})

const privacySettingSchema = z.object({ value: z.unknown(), setAt: z.number() })

const extensionStateSchema = z.object({
  removalGeneration: z.number().int().nonnegative().default(0),
  grantedPermissions: z.array(z.string()).default([]),
  grantedOrigins: z.array(z.string()).default([]),
  contextMenus: z.array(contextMenuItemSchema).default([]),
  /** scripting.RegisteredContentScript records, kept as Chrome shaped them. */
  contentScripts: z.array(z.record(z.string(), z.unknown())).default([]),
  privacy: z.record(z.string(), privacySettingSchema).default({}),
  /** Scripts this profile's worker registration was made from; a mismatch re-registers it. */
  workerSignature: z.string().optional(),
  /** Versions at the last load; absent means runtime.onInstalled has not fired in this profile. */
  lastLoaded: z.object({ extensionVersion: z.string(), chromiumVersion: z.string() }).optional(),
  /** sidePanel.setPanelBehavior; Chrome keeps it across restarts, unlike the panel options. */
  openSidePanelOnActionClick: z.boolean().optional()
})

export type StoredContextMenuItem = z.infer<typeof contextMenuItemSchema>
export type BrowserExtensionProfileState = z.infer<typeof extensionStateSchema>
type StateFile = Record<string, Record<string, BrowserExtensionProfileState>>

export function emptyBrowserExtensionProfileState(): BrowserExtensionProfileState {
  return extensionStateSchema.parse({})
}

/**
 * What Chrome keeps per extension per profile across restarts: granted optional permissions,
 * context menu items, persistAcrossSessions content scripts and privacy overrides, plus which
 * worker scripts the profile registered and the versions runtime.onInstalled last saw.
 */
export class BrowserExtensionProfileStateStore {
  private cache: StateFile | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly writer = new CoalescingFileWriter<string>((payload) => this.commit(payload))
  // Compared with the newest queued payload, not the landed one, so a revert behind a pending
  // write is still saved.
  private lastQueued: string | undefined
  // The revision last queued; a clean store never serializes. Starts at the loaded state's.
  private queuedRevision = 0
  private staleTempsSwept = false
  private closed = false
  /** Bumped by every change, so hot paths can cache what they derive from the state. */
  revision = 0

  constructor(private readonly rootDirectory: string) {}

  read(profileId: string, extensionId: string): BrowserExtensionProfileState {
    return this.load()[profileId]?.[extensionId] ?? emptyBrowserExtensionProfileState()
  }

  /** Every extension's state in one profile (privacy precedence spans extensions). */
  readProfile(profileId: string): Record<string, BrowserExtensionProfileState> {
    return { ...this.load()[profileId] }
  }

  update(
    profileId: string,
    extensionId: string,
    change: (state: BrowserExtensionProfileState) => BrowserExtensionProfileState
  ): BrowserExtensionProfileState {
    const file = this.load()
    const next = change(this.read(profileId, extensionId))
    file[profileId] = { ...file[profileId], [extensionId]: next }
    this.schedulePersist()
    return next
  }

  forgetExtension(extensionId: string): void {
    let forgot = false
    for (const byExtension of Object.values(this.load())) {
      if (extensionId in byExtension) {
        delete byExtension[extensionId]
        forgot = true
      }
    }
    if (forgot) {
      this.schedulePersist()
    }
  }

  forgetProfileExtension(profileId: string, extensionId: string): void {
    const byExtension = this.load()[profileId]
    if (byExtension && extensionId in byExtension) {
      delete byExtension[extensionId]
      this.schedulePersist()
    }
  }

  /** Drops one profile's state of every extension not in `extensionIds`. */
  forgetExtensionsExcept(profileId: string, extensionIds: ReadonlySet<string>): void {
    const byExtension = this.load()[profileId] ?? {}
    const forgotten = Object.keys(byExtension).filter((id) => !extensionIds.has(id))
    for (const extensionId of forgotten) {
      delete byExtension[extensionId]
    }
    if (forgotten.length > 0) {
      this.schedulePersist()
    }
  }

  forgetProfile(profileId: string): void {
    const file = this.load()
    if (profileId in file) {
      delete file[profileId]
      this.schedulePersist()
    }
  }

  /** Queues the current state now instead of after the debounce; the write runs off the main thread. */
  saveNow(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // Closed for quit: later changes stay in memory only.
    if (!this.cache || this.closed || this.revision === this.queuedRevision) {
      return
    }
    this.queuedRevision = this.revision
    const payload = JSON.stringify(this.cache)
    if (payload === this.lastQueued) {
      return
    }
    this.lastQueued = payload
    this.writer.save(payload)
  }

  /** Saves now and settles once it is on disk; throws if the first attempt fails (retries continue). */
  async flush(): Promise<void> {
    // After the final save, a change can't land, so a caller waiting on it (a removal marker) must not proceed.
    if (this.closed && this.revision !== this.queuedRevision) {
      throw new Error('Extension state is closed for quit')
    }
    this.saveNow()
    if (!(await this.writer.landed())) {
      throw new Error('Could not save extension state')
    }
  }

  /** Final save on quit; later changes stay in memory only. A failing save gets one more try. */
  close(): Promise<void> {
    this.saveNow()
    this.closed = true
    return this.writer.settled()
  }

  // Why debounce: extensions create menus item by item at startup.
  private schedulePersist(): void {
    this.revision++
    if (this.timer || this.closed) {
      return
    }
    this.timer = setTimeout(() => this.saveNow(), PERSIST_DELAY_MS)
  }

  // Why write-temp-then-rename: a crash mid-write must not lose every profile's state.
  private async commit(payload: string): Promise<boolean> {
    const target = join(this.rootDirectory, STATE_FILE_NAME)
    try {
      await mkdir(this.rootDirectory, { recursive: true })
      if (!this.staleTempsSwept) {
        this.staleTempsSwept = true
        // Temps a crashed run left; this process's own are still in use.
        await removeStaleDurableWriteTempFiles(target)
      }
      await writeFileDurable(durableWriteTempPath(target), target, payload)
      return true
    } catch (error) {
      console.warn('[browser-extensions] Could not save extension state:', error)
      return false
    }
  }

  private load(): StateFile {
    if (this.cache) {
      return this.cache
    }
    const file: StateFile = {}
    try {
      const raw: unknown = JSON.parse(
        readFileSync(join(this.rootDirectory, STATE_FILE_NAME), 'utf8')
      )
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [profileId, byExtension] of Object.entries(raw)) {
          if (!byExtension || typeof byExtension !== 'object') {
            continue
          }
          file[profileId] = {}
          for (const [extensionId, state] of Object.entries(byExtension)) {
            const parsed = extensionStateSchema.safeParse(state)
            if (parsed.success) {
              file[profileId][extensionId] = parsed.data
            }
          }
        }
      }
    } catch {
      // Missing or unreadable: start empty.
    }
    this.cache = file
    return file
  }
}

let stateStore: BrowserExtensionProfileStateStore | null = null
let quitClosing = false

export function getBrowserExtensionProfileStateStore(): BrowserExtensionProfileStateStore {
  if (!stateStore) {
    stateStore = new BrowserExtensionProfileStateStore(getBrowserExtensionProfileDataDirectory())
    if (quitClosing) {
      void stateStore.close()
    }
  }
  return stateStore
}

/** Final save on quit; never rejects. */
export function closeBrowserExtensionProfileStateStore(): Promise<void> {
  quitClosing = true
  return stateStore?.close() ?? Promise.resolve()
}
