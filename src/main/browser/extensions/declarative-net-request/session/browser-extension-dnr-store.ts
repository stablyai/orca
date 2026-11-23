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

type SessionRules = { version: string; rules: DnrRule[] }

/**
 * Session rules stay in memory across the extension's unloads (idle profile, disable, reload)
 * until a new version is installed, it is uninstalled or the profile deleted, as Chrome keeps them.
 */
class BrowserExtensionDnrStore extends BrowserExtensionProfileDocumentStore {
  private readonly sessionRules = new Map<string, Map<string, SessionRules>>()

  readSessionRules(profileId: string, extension: Pick<Electron.Extension, 'id' | 'version'>) {
    const saved = this.sessionRules.get(profileId)?.get(extension.id)
    if (saved && saved.version !== extension.version) {
      // A new version starts without the old one's rules, even if that version comes back later.
      this.writeSessionRules(profileId, extension, [])
      return []
    }
    return saved?.rules ?? []
  }

  writeSessionRules(
    profileId: string,
    extension: Pick<Electron.Extension, 'id' | 'version'>,
    rules: DnrRule[]
  ): void {
    const byExtension = this.sessionRules.get(profileId) ?? new Map<string, SessionRules>()
    if (rules.length > 0) {
      byExtension.set(extension.id, { version: extension.version, rules })
    } else {
      byExtension.delete(extension.id)
    }
    if (byExtension.size > 0) {
      this.sessionRules.set(profileId, byExtension)
    } else {
      this.sessionRules.delete(profileId)
    }
  }

  override forgetExtension(extensionId: string): Promise<void> {
    for (const [profileId, byExtension] of this.sessionRules) {
      byExtension.delete(extensionId)
      if (byExtension.size === 0) {
        this.sessionRules.delete(profileId)
      }
    }
    return super.forgetExtension(extensionId)
  }

  override forgetProfileExtension(profileId: string, extensionId: string): Promise<void> {
    this.forgetSessionRulesOf(profileId, extensionId)
    return super.forgetProfileExtension(profileId, extensionId)
  }

  override forgetExtensionsExcept(
    profileId: string,
    extensionIds: ReadonlySet<string>
  ): Promise<void> {
    this.forgetSessionRulesExcept(profileId, (id) => extensionIds.has(id))
    return super.forgetExtensionsExcept(profileId, extensionIds)
  }

  /** A reload or update installed this copy: rules another version left go in every profile. */
  forgetSessionRulesOfOtherVersions(extension: Pick<Electron.Extension, 'id' | 'version'>): void {
    for (const profileId of this.sessionRules.keys()) {
      const saved = this.sessionRules.get(profileId)?.get(extension.id)
      if (saved && saved.version !== extension.version) {
        this.forgetSessionRulesOf(profileId, extension.id)
      }
    }
  }

  /** Extensions turned off, like a browser quit: every profile's session rules go. */
  forgetAllSessionRules(): void {
    this.sessionRules.clear()
  }

  private forgetSessionRulesOf(profileId: string, extensionId: string): void {
    const byExtension = this.sessionRules.get(profileId)
    if (byExtension?.delete(extensionId) && byExtension.size === 0) {
      this.sessionRules.delete(profileId)
    }
  }

  private forgetSessionRulesExcept(profileId: string, keeps: (extensionId: string) => boolean) {
    const byExtension = this.sessionRules.get(profileId)
    for (const extensionId of byExtension?.keys() ?? []) {
      if (!keeps(extensionId)) {
        byExtension?.delete(extensionId)
      }
    }
    if (byExtension?.size === 0) {
      this.sessionRules.delete(profileId)
    }
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
