import { app } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

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
  grantedPermissions: z.array(z.string()).default([]),
  grantedOrigins: z.array(z.string()).default([]),
  contextMenus: z.array(contextMenuItemSchema).default([]),
  /** scripting.RegisteredContentScript records, kept as Chrome shaped them. */
  contentScripts: z.array(z.record(z.string(), z.unknown())).default([]),
  privacy: z.record(z.string(), privacySettingSchema).default({}),
  /** Scripts this profile's worker registration was made from; a mismatch re-registers it. */
  workerSignature: z.string().optional(),
  /** Versions at the last load; absent means runtime.onInstalled has not fired in this profile. */
  lastLoaded: z.object({ extensionVersion: z.string(), chromiumVersion: z.string() }).optional()
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
    const file = this.load()
    for (const byExtension of Object.values(file)) {
      delete byExtension[extensionId]
    }
    this.schedulePersist()
  }

  forgetProfile(profileId: string): void {
    delete this.load()[profileId]
    this.schedulePersist()
  }

  // Why write-temp-then-rename: a crash mid-write must not lose every profile's state.
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.cache) {
      return
    }
    mkdirSync(this.rootDirectory, { recursive: true })
    const target = join(this.rootDirectory, STATE_FILE_NAME)
    writeFileSync(`${target}.tmp`, JSON.stringify(this.cache))
    renameSync(`${target}.tmp`, target)
  }

  // Why debounce: extensions create menus item by item at startup.
  private schedulePersist(): void {
    this.revision++
    if (this.timer) {
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      try {
        this.flush()
      } catch (error) {
        console.warn('[browser-extensions] Could not save extension state:', error)
      }
    }, PERSIST_DELAY_MS)
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

export function getBrowserExtensionProfileStateStore(): BrowserExtensionProfileStateStore {
  if (!stateStore) {
    const store = new BrowserExtensionProfileStateStore(
      join(app.getPath('userData'), 'browser-extensions')
    )
    app.on('will-quit', () => store.flush())
    stateStore = store
  }
  return stateStore
}
