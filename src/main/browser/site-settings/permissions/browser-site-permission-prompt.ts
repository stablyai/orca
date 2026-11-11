import {
  BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN,
  isBrowserSitePermissionDecision,
  type BrowserSitePermission
} from '../../../../shared/browser-site-permission'
import { isEligibleLocalCertificateHost } from '../../../../shared/browser-url'
import { browserManager } from '../../guest-lifecycle/manager/browser-manager'
import {
  browserPagePromptOrigin,
  openBrowserPagePrompt
} from '../../guest-lifecycle/prompts/browser-page-prompts'
import type { BrowserSitePermissionMemory } from './browser-site-permission-memory'

/** Returns null for opaque sites; local files share one permission origin. */
export function browserSitePermissionOrigin(rawUrl: string | null): string | null {
  return rawUrl?.startsWith('file:')
    ? BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN
    : browserPagePromptOrigin(rawUrl)
}

// Opaque frame URLs can inherit origins; refuse ambiguous matches when walking the frames.
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

type SitePermissionSource = { pageUrl: string | null; frameOrigin: string | null }

// Notifications use the frame's own site and may prompt only for the tab's site; other grants use the tab.
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
      // Coalesce repeated requests until the user answers.
      coalesceKey: `${origin} ${unanswered.join(' ')}`,
      parseAnswer: (value) => (isBrowserSitePermissionDecision(value) ? value : undefined),
      settle: (decision) => {
        if (decision) {
          memory.set(origin, unanswered, decision)
        }
        resolve(decision === 'allow')
      }
    })
    // A missing, suppressed or already-open prompt cannot grant an unanswered permission.
    if (opening !== 'prompting') {
      resolve(false)
    }
  })
}

function isLoopbackPage(pageUrl: string | null): boolean {
  try {
    return pageUrl !== null && isEligibleLocalCertificateHost(new URL(pageUrl).hostname)
  } catch {
    return false
  }
}

const LOCAL_NETWORK = ['local-network'] as const

// Electron turns off Chromium's Local Network Access checks, so no request ever arrives;
// a page's permission query is the only moment to ask.
export function answerBrowserLocalNetworkCheck(args: {
  requester: Electron.WebContents | null
  source: SitePermissionSource
  memory: BrowserSitePermissionMemory
}): boolean {
  const { requester, source, memory } = args
  // Chrome never gates pages served from loopback, such as localhost dev servers.
  if (
    isLoopbackPage(source.pageUrl) ||
    isBrowserSitePermissionAllowed({ source, memory, permissions: LOCAL_NETWORK })
  ) {
    return true
  }
  if (requester) {
    decideBrowserSitePermissions({
      requester,
      frameOrigin: source.frameOrigin,
      memory,
      permissions: LOCAL_NETWORK
    }).catch((error: unknown) => {
      console.error('[permissions] Local network prompt failed:', error)
    })
  }
  return false
}
