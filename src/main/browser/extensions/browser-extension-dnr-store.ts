import { app } from 'electron'
import { join } from 'node:path'
import { z } from 'zod'
import { BrowserExtensionSyncStorageStore } from './browser-extension-sync-storage-store'

/**
 * What Chrome persists per extension per profile for declarativeNetRequest: dynamic rules, the
 * enabled static rulesets and disabled static rule ids (both reset when the extension updates),
 * and the action-count badge option. Session rules live only in memory.
 */
const dnrStateSchema = z.object({
  dynamicRules: z.array(z.unknown()).default([]),
  /** The version the static-ruleset choices below were made for. */
  extensionVersion: z.string().optional(),
  enabledRulesetIds: z.array(z.string()).optional(),
  disabledRuleIds: z.record(z.string(), z.array(z.number().int())).default({}),
  displayActionCountAsBadgeText: z.boolean().default(false)
})

export type BrowserExtensionDnrState = z.infer<typeof dnrStateSchema>

let store: BrowserExtensionSyncStorageStore | null = null

export function getBrowserExtensionDnrStore(): BrowserExtensionSyncStorageStore {
  if (!store) {
    const created = new BrowserExtensionSyncStorageStore(
      join(app.getPath('userData'), 'browser-extensions'),
      'declarative-net-request'
    )
    app.on('will-quit', () => created.flush())
    store = created
  }
  return store
}

/** Static-ruleset choices made for another version are dropped, as Chrome does on update. */
export function readBrowserExtensionDnrState(
  profileId: string,
  extension: Pick<Electron.Extension, 'id' | 'version'>
): BrowserExtensionDnrState {
  const parsed = dnrStateSchema.safeParse(
    getBrowserExtensionDnrStore().read(profileId, extension.id)
  )
  const state = parsed.success ? parsed.data : dnrStateSchema.parse({})
  if (state.extensionVersion === extension.version) {
    return state
  }
  return { ...state, enabledRulesetIds: undefined, disabledRuleIds: {} }
}

export function updateBrowserExtensionDnrState(
  profileId: string,
  extension: Pick<Electron.Extension, 'id' | 'version'>,
  change: Partial<BrowserExtensionDnrState>
): void {
  const next: BrowserExtensionDnrState = {
    ...readBrowserExtensionDnrState(profileId, extension),
    ...change,
    extensionVersion: extension.version
  }
  getBrowserExtensionDnrStore().write(profileId, extension.id, next)
}
