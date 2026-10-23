import {
  BROWSER_SITE_PERMISSIONS,
  BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN,
  isBrowserSitePermissionDecision,
  type BrowserSitePermission,
  type BrowserSitePermissionDecision
} from '../../shared/browser-site-permission'
import { browserManager } from './browser-manager'
import { browserPagePromptOrigin, openBrowserPagePrompt } from './browser-page-prompts'
import {
  getBrowserSitePermissionDecision,
  setBrowserSitePermissionDecisions
} from './browser-site-permission-store'

const SITE_PERMISSION_BY_ELECTRON_PERMISSION: Partial<Record<string, BrowserSitePermission>> = {
  geolocation: 'location',
  notifications: 'notifications',
  'clipboard-read': 'clipboard',
  midi: 'midi',
  midiSysex: 'midi',
  'window-management': 'window-management',
  'idle-detection': 'idle-detection'
}

const SITE_PERMISSION_BY_MEDIA_TYPE: Partial<Record<string, BrowserSitePermission>> = {
  video: 'camera',
  audio: 'microphone'
}

/**
 * What the user decides for an Electron permission: null when it is not theirs to decide. An empty
 * list (media naming no device) is never granted.
 */
export function browserSitePermissionsFor(
  permission: string,
  mediaTypes: readonly string[] | undefined
): BrowserSitePermission[] | null {
  if (permission === 'media') {
    const requested = new Set((mediaTypes ?? []).map((type) => SITE_PERMISSION_BY_MEDIA_TYPE[type]))
    // Why: the prompt lists camera before microphone whatever order Chromium reports them in.
    return BROWSER_SITE_PERMISSIONS.filter((sitePermission) => requested.has(sitePermission))
  }
  const sitePermission = SITE_PERMISSION_BY_ELECTRON_PERMISSION[permission]
  return sitePermission ? [sitePermission] : null
}

/** Where one browser session's answers live. */
export type BrowserSitePermissionMemory = {
  get(origin: string, permission: BrowserSitePermission): BrowserSitePermissionDecision | undefined
  set(
    origin: string,
    permissions: readonly BrowserSitePermission[],
    decision: BrowserSitePermissionDecision
  ): void
}

/** A browser profile's answers, saved and listed in settings. */
export function savedBrowserSitePermissions(profileId: string): BrowserSitePermissionMemory {
  return {
    get: (origin, permission) => getBrowserSitePermissionDecision(profileId, origin, permission),
    set: (origin, permissions, decision) =>
      setBrowserSitePermissionDecisions(profileId, origin, permissions, decision)
  }
}

const sessionMemories = new Map<string, BrowserSitePermissionMemory>()

/**
 * Answers kept until Orca quits, for a paired server's profile, which settings here cannot list.
 * Keyed by partition: closing its last page drops the handlers but must not forget the answers.
 */
export function sessionBrowserSitePermissions(partition: string): BrowserSitePermissionMemory {
  const existing = sessionMemories.get(partition)
  if (existing) {
    return existing
  }
  const decisions = new Map<string, BrowserSitePermissionDecision>()
  const memory: BrowserSitePermissionMemory = {
    get: (origin, permission) => decisions.get(`${origin} ${permission}`),
    set: (origin, permissions, decision) => {
      for (const permission of permissions) {
        decisions.set(`${origin} ${permission}`, decision)
      }
    }
  }
  sessionMemories.set(partition, memory)
  return memory
}

/** The site a page's permissions belong to; null for opaque pages, which are never granted. */
export function browserSitePermissionOrigin(rawUrl: string | null): string | null {
  return rawUrl?.startsWith('file:')
    ? BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN
    : browserPagePromptOrigin(rawUrl)
}

/**
 * The asking frame's real origin. Request details carry only its URL, and an about:blank or srcdoc
 * frame inherits its creator's origin, so read it off the frame. Null when frames at that URL differ.
 */
export function browserSitePermissionRequestingOrigin(
  contents: Electron.WebContents,
  details: { requestingUrl?: string; isMainFrame?: boolean }
): string | null {
  if (details.isMainFrame !== false || !details.requestingUrl) {
    return contents.getURL()
  }
  try {
    const origins = new Set(
      contents.mainFrame.framesInSubtree
        .filter((frame) => frame.url === details.requestingUrl)
        .map((frame) => frame.origin)
    )
    return origins.size === 1 ? [...origins][0] : null
  } catch {
    // A frame disposed mid-walk throws on access.
    return null
  }
}

/** The tab and the asking frame's real origin; null `frameOrigin` grants that frame nothing. */
type SitePermissionSource = { pageUrl: string | null; frameOrigin: string | null }

/**
 * Whose answers apply (null grants nothing) and whether that site may be asked now. As in Chrome,
 * a frame shares its tab's answers, except notifications, which belong to the frame's own site and
 * are only asked for by the tab's site.
 */
function answeringSite(
  { pageUrl, frameOrigin }: SitePermissionSource,
  permissions: readonly BrowserSitePermission[]
): { origin: string | null; mayAsk: boolean } {
  const pageOrigin = browserSitePermissionOrigin(pageUrl)
  if (!permissions.includes('notifications')) {
    return { origin: pageOrigin, mayAsk: true }
  }
  const origin = browserSitePermissionOrigin(frameOrigin)
  return { origin, mayAsk: origin === pageOrigin }
}

export function isBrowserSitePermissionAllowed(args: {
  source: SitePermissionSource
  memory: BrowserSitePermissionMemory
  permissions: readonly BrowserSitePermission[]
}): boolean {
  const { origin } = answeringSite(args.source, args.permissions)
  return (
    origin !== null &&
    args.permissions.length > 0 &&
    args.permissions.every((permission) => args.memory.get(origin, permission) === 'allow')
  )
}

/**
 * Resolves true when the page may have every permission: each was allowed before, or the user
 * allows the rest now. Any remembered Block refuses without asking.
 */
export function decideBrowserSitePermissions(args: {
  requester: Electron.WebContents
  frameOrigin: string | null
  memory: BrowserSitePermissionMemory
  permissions: readonly BrowserSitePermission[]
}): Promise<boolean> {
  const { requester, memory, permissions } = args
  const { origin, mayAsk } = answeringSite(
    { pageUrl: requester.getURL(), frameOrigin: args.frameOrigin },
    permissions
  )
  if (origin === null || permissions.length === 0) {
    return Promise.resolve(false)
  }
  const decisions = permissions.map((permission) => memory.get(origin, permission))
  if (decisions.includes('block')) {
    return Promise.resolve(false)
  }
  const unanswered = permissions.filter((_, index) => decisions[index] === undefined)
  if (unanswered.length === 0) {
    return Promise.resolve(true)
  }
  if (!mayAsk) {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const opening = openBrowserPagePrompt({
      kind: 'site-permission',
      requester,
      target: browserManager.resolvePagePromptTarget(requester),
      details: () => ({ origin, permissions: unanswered }),
      // Why: a page asking again for the same thing before the user answers gets one question.
      coalesceKey: `${origin} ${unanswered.join(' ')}`,
      parseAnswer: (value) => (isBrowserSitePermissionDecision(value) ? value : undefined),
      settle: (decision) => {
        if (decision) {
          memory.set(origin, unanswered, decision)
        }
        resolve(decision === 'allow')
      }
    })
    // Why: no window to ask (a headless server), or the page is quiet or already asking.
    if (opening !== 'prompting') {
      resolve(false)
    }
  })
}
