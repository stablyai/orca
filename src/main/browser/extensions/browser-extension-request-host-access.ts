import type { DnrHostAccess } from './declarative-net-request/extension-matcher'
import { browserExtensionActiveTabCovers } from './browser-extension-active-tab'
import { matchesExtensionMatchPattern } from './browser-extension-match-pattern'
import { manifestPermissionSets } from './browser-extension-permission-grants'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'

/** Host patterns split so the common "every site" grants need no URL parsing per request. */
type CompiledHostPatterns = { schemes: ReadonlySet<string>; others: readonly string[] }

const ALL_HOSTS = /^(\*|https?|wss?):\/\/\*\/\*$/
const WEB_SCHEMES = ['http', 'https', 'ws', 'wss']

function compile(patterns: readonly string[]): CompiledHostPatterns {
  const schemes = new Set<string>()
  const others: string[] = []
  for (const pattern of patterns) {
    const scheme = pattern === '<all_urls>' ? '*' : ALL_HOSTS.exec(pattern)?.[1]
    if (scheme === undefined) {
      others.push(pattern)
    } else {
      for (const covered of scheme === '*' ? WEB_SCHEMES : [scheme]) {
        schemes.add(covered)
      }
    }
  }
  return { schemes, others }
}

function allows(compiled: CompiledHostPatterns, url: string): boolean {
  const scheme = url.slice(0, url.indexOf(':')).toLowerCase()
  return (
    compiled.schemes.has(scheme) ||
    compiled.others.some((pattern) => matchesExtensionMatchPattern(pattern, url))
  )
}

export type ExtensionRequestTarget = {
  url: string
  /** Serialised initiator origin; null or "null" when opaque or absent. */
  initiator: string | null
  tabId: number
  /** Chrome resource type; navigations skip the initiator check. */
  type?: string
}

/**
 * WebRequestPermissions::CanExtensionAccessURL with REQUIRE_HOST_PERMISSION_FOR_URL_AND_INITIATOR,
 * shared by webRequest and declarativeNetRequest. `hostAllowed` is the extension's host grants;
 * an activeTab grant adds only its tab's page origin. Orca has no runtime host withholding, so
 * access is allowed or denied, never withheld.
 */
export function canExtensionAccessRequest(
  extensionId: string,
  request: ExtensionRequestTarget,
  hostAllowed: (url: string) => boolean
): boolean {
  const allowed = (url: string): boolean =>
    url.startsWith('about:') ||
    url.toLowerCase().startsWith(`chrome-extension://${extensionId}/`) ||
    hostAllowed(url) ||
    (request.tabId >= 0 && browserExtensionActiveTabCovers(extensionId, request.tabId, url))
  if (!allowed(request.url)) {
    return false
  }
  // crbug.com/41433450: only sub-resource requests need access to their initiator.
  if (request.type === 'main_frame' || request.type === 'sub_frame') {
    return true
  }
  const { initiator } = request
  return initiator === null || initiator === 'null' || allowed(`${initiator}/`)
}

/** canExtensionAccessRequest for one extension in one profile, as the DNR engine asks it. */
export class DnrExtensionHostAccess {
  private readonly requiredPatterns: string[]
  private compiled: CompiledHostPatterns | null = null
  private compiledAtRevision = -1

  constructor(
    private readonly profileId: string,
    private readonly extensionId: string,
    manifest: unknown
  ) {
    const record =
      manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
        ? Object.fromEntries(Object.entries(manifest))
        : undefined
    this.requiredPatterns = manifestPermissionSets(record).required.origins
  }

  // Why cached by store revision: the engine asks once per extension for every request.
  private patternsNow(): CompiledHostPatterns {
    const store = getBrowserExtensionProfileStateStore()
    if (!this.compiled || this.compiledAtRevision !== store.revision) {
      const granted = store.read(this.profileId, this.extensionId).grantedOrigins
      this.compiled = compile([...this.requiredPatterns, ...granted])
      this.compiledAtRevision = store.revision
    }
    return this.compiled
  }

  access(url: string, initiator: string | null, tabId: number, type?: string): DnrHostAccess {
    const patterns = this.patternsNow()
    return canExtensionAccessRequest(this.extensionId, { url, initiator, tabId, type }, (target) =>
      allows(patterns, target)
    )
      ? 'allowed'
      : 'denied'
  }
}
