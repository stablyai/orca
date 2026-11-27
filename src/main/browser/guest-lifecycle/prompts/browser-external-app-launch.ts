import { app, shell } from 'electron'

import { DOC_PREVIEW_SCHEME } from '../../../../shared/document-preview/doc-preview-scheme'
import { BROWSER_EXTENSION_API_SCHEME } from '../../../../shared/browser/extensions/browser-extension-worker-api'
import {
  BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN,
  browserExternalAppPermission
} from '../../../../shared/browser/site-settings/browser-site-permission'
import { isEligibleLocalCertificateHost } from '../../../../shared/browser/navigation/browser-url'
import { browserSessionSitePermissions } from '../../site-settings/permissions/browser-site-permission-memory'
import {
  BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS,
  getLastBrowserGuestInputInSession,
  isRecentBrowserGuestInput
} from '../input/browser-guest-input-gesture'
import {
  browserPagePromptOrigin,
  browserSitePermissionOrigin,
  openBrowserPagePrompt,
  type BrowserPagePromptTarget
} from './browser-page-prompts'

// Deny web/internal schemes and Chrome's kDeniedSchemes (scripts, shell folders, shares).
const NEVER_EXTERNAL_APP_PROTOCOLS: ReadonlySet<string> = new Set([
  'about:',
  'afp:',
  'blob:',
  'chrome:',
  // Why: extension pages and Orca's extension API are browser-internal, as in Chrome.
  'chrome-extension:',
  `${BROWSER_EXTENSION_API_SCHEME}:`,
  'data:',
  'devtools:',
  'disk:',
  'disks:',
  'file:',
  'filesystem:',
  'hcp:',
  'http:',
  'https:',
  'ie.http:',
  'javascript:',
  'ms-help:',
  'nntp:',
  'res:',
  'shell:',
  'vbscript:',
  'view-source:',
  'vnd.ms.radio:',
  `${DOC_PREVIEW_SCHEME}:`
])

export function toBrowserExternalAppUrl(rawUrl: string | undefined): URL | null {
  if (!rawUrl) {
    return null
  }
  try {
    const url = new URL(rawUrl)
    return NEVER_EXTERNAL_APP_PROTOCOLS.has(url.protocol) ? null : url
  } catch {
    return null
  }
}

function externalAppName(url: string): string | null {
  // Linux returns a .desktop file ID rather than a display name.
  if (process.platform === 'linux') {
    return null
  }
  try {
    return app.getApplicationNameForProtocol(url) || null
  } catch {
    return null
  }
}

export function initiatingFrameUrl(frame: Electron.WebFrameMain | null | undefined): string | null {
  try {
    return frame && !frame.isDestroyed() ? frame.url : null
  } catch {
    return null
  }
}

async function launchExternalApp(url: string): Promise<'failed' | undefined> {
  try {
    await shell.openExternal(url)
    return undefined
  } catch (error) {
    console.warn('[browser] Could not open link in another app:', error)
    return 'failed'
  }
}

/** A streamed server page's link the user chose to open here; the same schemes are refused as for local pages. */
export async function openStreamedBrowserExternalAppLink(rawUrl: unknown): Promise<boolean> {
  const url = typeof rawUrl === 'string' ? toBrowserExternalAppUrl(rawUrl) : null
  return url !== null && (await launchExternalApp(url.href)) !== 'failed'
}

// As in Chrome, remember only sites a network attacker can't impersonate.
function isRememberableSite(site: string): boolean {
  if (site === BROWSER_SITE_PERMISSION_LOCAL_FILES_ORIGIN) {
    return true
  }
  try {
    const { protocol, hostname } = new URL(site)
    return (
      protocol === 'https:' || (protocol === 'http:' && isEligibleLocalCertificateHost(hostname))
    )
  } catch {
    return false
  }
}

function pageUrl(contents: Electron.WebContents): string | null {
  try {
    return contents.getURL()
  } catch {
    return null
  }
}

function hasExternalAppHandler(url: string): boolean {
  try {
    return app.getApplicationNameForProtocol(url) !== ''
  } catch {
    return false
  }
}

// Input up to `clicksSpentUntil` already paid for the launch at `at`.
const lastLaunch = new WeakMap<Electron.WebContents, { at: number; clicksSpentUntil: number }>()

/** When the desktop user last clicked this page, if just now; agents' and other pages' input don't count. */
function desktopUserClickAt(guest: Electron.WebContents, now: number): number | null {
  const input = getLastBrowserGuestInputInSession(guest.session)
  return input &&
    !input.byAgent &&
    input.guestWebContentsId === guest.id &&
    isRecentBrowserGuestInput(input.at, now)
    ? input.at
    : null
}

/** Require a prompt so pages cannot launch apps unasked; a streamed page's viewer opens the link itself, never the server. */
export function requestBrowserExternalAppLaunch(args: {
  requester: Electron.WebContents
  target: BrowserPagePromptTarget | null
  rawUrl: string | undefined
  /** Null omits the site from the prompt. */
  requestingUrl: () => string | null
  /** False when the browser itself navigated (address bar, agent goto), so the tab's page never asked. */
  pageInitiated?: boolean
}): boolean {
  const { requester, target } = args
  const url = toBrowserExternalAppUrl(args.rawUrl)
  if (!url || requester.isDestroyed()) {
    return false
  }
  const scheme = url.protocol.slice(0, -1)
  const origin = browserPagePromptOrigin(args.requestingUrl())
  // Unnamed frames (sandboxed, no referrer) answer for the tab's site, like other site permissions.
  const site =
    origin ??
    (args.pageInitiated === false ? null : browserSitePermissionOrigin(pageUrl(requester)))
  const streamed = target === 'stream-viewers'
  // A server's remembered answers would launch apps on the server, so streamed pages always ask.
  const memory =
    target && !streamed && site && isRememberableSite(site)
      ? browserSessionSitePermissions(requester.session)
      : null
  const rememberSite = memory ? site : null
  const permission = browserExternalAppPermission(scheme)
  const prompt = (): ReturnType<typeof openBrowserPagePrompt> =>
    openBrowserPagePrompt({
      kind: 'external-app',
      requester,
      target,
      details: () =>
        streamed
          ? { appName: null, scheme, origin, rememberSite, url: url.href }
          : { appName: externalAppName(url.href), scheme, origin, rememberSite },
      parseAnswer: (value) => (value === true || value === 'always' ? value : undefined),
      settle: (answer) => {
        if (!answer || streamed) {
          return undefined
        }
        if (answer === 'always' && rememberSite) {
          memory?.set(rememberSite, [permission], 'allow')
        }
        // The click that raised this prompt is spent; clicks after the answer are new.
        const answeredAt = Date.now()
        lastLaunch.set(requester, { at: answeredAt, clicksSpentUntil: answeredAt })
        return launchExternalApp(url.href)
      }
    })
  const now = Date.now()
  const clickAt = desktopUserClickAt(requester, now)
  if (clickAt !== null && rememberSite && memory?.get(rememberSite, permission) === 'allow') {
    // As in Chrome, one click opens one app; the page's other attempts from it are dropped.
    const previous = lastLaunch.get(requester)
    const spent = previous !== undefined && clickAt <= previous.clicksSpentUntil
    if (spent && isRecentBrowserGuestInput(previous.at, now)) {
      return true
    }
    // The OS handler lookup blocks the main thread, so it runs only for an unspent click.
    if (!spent && hasExternalAppHandler(url.href)) {
      // A click's release comes after its press launched the app, so it is spent too.
      lastLaunch.set(requester, {
        at: now,
        clicksSpentUntil: now + BROWSER_GUEST_INPUT_GESTURE_WINDOW_MS
      })
      // A failed launch asks instead, so Open can report why nothing opened.
      void launchExternalApp(url.href).then((result) => {
        if (result === 'failed') {
          prompt()
        }
      })
      return true
    }
  }
  const opening = prompt()
  // Keep blocking the link even when a quiet or busy page suppresses the prompt.
  return opening !== 'no-window'
}
