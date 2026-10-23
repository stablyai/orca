import type { DnrHostAccess } from './declarative-net-request/extension-matcher'
import { hasBrowserExtensionActiveTab } from './browser-extension-active-tab'
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

/**
 * WebRequestPermissions::CanExtensionAccessURL for one extension in one profile: manifest host
 * permissions, origins the user granted, and an activeTab grant for the request's tab. Orca has
 * no runtime host withholding, so access is allowed or denied, never withheld.
 */
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

  /** REQUIRE_HOST_PERMISSION_FOR_URL_AND_INITIATOR. */
  access(url: string, initiator: string | null, tabId: number): DnrHostAccess {
    if (tabId >= 0 && hasBrowserExtensionActiveTab(this.extensionId, tabId)) {
      return 'allowed'
    }
    const patterns = this.patternsNow()
    const initiatorAllowed =
      initiator === null || initiator === 'null' || allows(patterns, `${initiator}/`)
    return initiatorAllowed && allows(patterns, url) ? 'allowed' : 'denied'
  }
}
