import { z } from 'zod'
import {
  BrowserExtensionProfileDocumentStore,
  closeBrowserExtensionProfileDocumentStoreOnQuit
} from '../../profile-storage/browser-extension-profile-document-store'
import { getBrowserExtensionProfileDataDirectory } from '../../profile-storage/browser-extension-profile-data-directory'
import type { DnrRule } from '../rule-compilation/rule-types'

/**
 * What Chrome persists per extension per profile for declarativeNetRequest: dynamic rules, the
 * enabled static rulesets and disabled static rule ids (both reset when the extension updates),
 * and the action-count badge option. Session rules live only in memory (see below).
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

/**
 * Session rules stay in memory across the extension's unloads (idle profile, disable, reload,
 * update) until it is uninstalled or the profile deleted, as Chrome keeps them per profile.
 */
class BrowserExtensionDnrStore extends BrowserExtensionProfileDocumentStore {
  private readonly sessionRules = new Map<string, Map<string, DnrRule[]>>()

  readSessionRules(profileId: string, extensionId: string): DnrRule[] {
    return this.sessionRules.get(profileId)?.get(extensionId) ?? []
  }

  writeSessionRules(profileId: string, extensionId: string, rules: DnrRule[]): void {
    let byExtension = this.sessionRules.get(profileId)
    if (!byExtension) {
      byExtension = new Map()
      this.sessionRules.set(profileId, byExtension)
    }
    if (rules.length > 0) {
      byExtension.set(extensionId, rules)
    } else {
      byExtension.delete(extensionId)
    }
  }

  override forgetExtension(extensionId: string): Promise<void> {
    for (const byExtension of this.sessionRules.values()) {
      byExtension.delete(extensionId)
    }
    return super.forgetExtension(extensionId)
  }

  override forgetProfileExtension(profileId: string, extensionId: string): Promise<void> {
    this.sessionRules.get(profileId)?.delete(extensionId)
    return super.forgetProfileExtension(profileId, extensionId)
  }

  override forgetExtensionsExcept(
    profileId: string,
    extensionIds: ReadonlySet<string>
  ): Promise<void> {
    const byExtension = this.sessionRules.get(profileId)
    for (const extensionId of byExtension?.keys() ?? []) {
      if (!extensionIds.has(extensionId)) {
        byExtension?.delete(extensionId)
      }
    }
    return super.forgetExtensionsExcept(profileId, extensionIds)
  }

  override forgetProfile(profileId: string): Promise<void> {
    this.sessionRules.delete(profileId)
    return super.forgetProfile(profileId)
  }
}

let store: BrowserExtensionDnrStore | null = null

export function getBrowserExtensionDnrStore(): BrowserExtensionDnrStore {
  if (!store) {
    const created = new BrowserExtensionDnrStore(
      getBrowserExtensionProfileDataDirectory(),
      'declarative-net-request'
    )
    closeBrowserExtensionProfileDocumentStoreOnQuit(created)
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
