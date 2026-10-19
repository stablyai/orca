import { randomUUID } from 'node:crypto'
import { app, shell } from 'electron'

import type {
  BrowserExternalAppRequest,
  BrowserExternalAppResponse,
  BrowserExternalAppResponseResult
} from '../../shared/browser-external-app'
import { DOC_PREVIEW_SCHEME } from '../../shared/doc-preview-scheme'
import { isActivatingBrowserGuestInput } from './browser-guest-input-gesture'

export const BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS = 120_000

// Web and browser-internal schemes, plus Chrome's denied list (kDeniedSchemes): handlers that run
// scripts, open shell folders or mount shares. Every other scheme belongs to an app on the computer.
const NEVER_EXTERNAL_APP_PROTOCOLS: ReadonlySet<string> = new Set([
  'about:',
  'afp:',
  'blob:',
  'chrome:',
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

type PendingLaunch = {
  url: string
  browserPageId: string
  requester: Electron.WebContents
  renderer: Electron.WebContents
  timer: ReturnType<typeof setTimeout>
}

const pendingLaunches = new Map<string, PendingLaunch>()
// Contents ids whose last prompt was refused; they stay silent until the user clicks or types in them.
const requestersAwaitingInput = new Set<number>()

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

function requestingOrigin(requestingUrl: string | null): string | null {
  if (!requestingUrl) {
    return null
  }
  try {
    const { origin } = new URL(requestingUrl)
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function externalAppName(url: string): string | null {
  // Why: Linux reports a .desktop file id, not a name people recognise.
  if (process.platform === 'linux') {
    return null
  }
  try {
    return app.getApplicationNameForProtocol(url) || null
  } catch {
    return null
  }
}

/** URL of the frame that started a navigation, or null when Electron cannot say. */
export function initiatingFrameUrl(frame: Electron.WebFrameMain | null | undefined): string | null {
  try {
    return frame && !frame.isDestroyed() ? frame.url : null
  } catch {
    // A disposed frame throws on access.
    return null
  }
}

function dropPendingLaunch(requestId: string): PendingLaunch | null {
  const pending = pendingLaunches.get(requestId)
  if (!pending) {
    return null
  }
  clearTimeout(pending.timer)
  pendingLaunches.delete(requestId)
  return pending
}

function closePendingLaunch(requestId: string): PendingLaunch | null {
  const pending = dropPendingLaunch(requestId)
  try {
    if (pending && !pending.renderer.isDestroyed()) {
      // Why: an Open click after the request is gone would do nothing, so the prompt must go too.
      pending.renderer.send('browser:external-app-request-closed', { requestId })
    }
  } catch {
    // Renderer may be destroyed between the check and send.
  }
  return pending
}

/**
 * Why: the prompt is app-modal, so a page looping a deep link would re-open it after every Cancel
 * and lock the user out of Orca. As in Chrome, a refused page must get real input before asking again.
 */
function silenceUntilInput(requester: Electron.WebContents): void {
  const { id } = requester
  if (requester.isDestroyed() || requestersAwaitingInput.has(id)) {
    return
  }
  requestersAwaitingInput.add(id)
  const release = (): void => {
    requestersAwaitingInput.delete(id)
    try {
      requester.off('input-event', onInput)
      requester.off('destroyed', release)
    } catch {
      // Contents may already be destroyed.
    }
  }
  const onInput = (_event: Electron.Event, input: Electron.InputEvent): void => {
    if (isActivatingBrowserGuestInput(input)) {
      release()
    }
  }
  requester.on('input-event', onInput)
  requester.once('destroyed', release)
}

/** The page is gone, so its prompt must not stay up and launch an app on its behalf. */
export function cancelBrowserExternalAppRequests(browserPageId: string): void {
  for (const [requestId, pending] of pendingLaunches) {
    if (pending.browserPageId === browserPageId) {
      closePendingLaunch(requestId)
    }
  }
}

/**
 * Asks the window showing the page whether to open the link in its app; Orca launches it only on
 * a yes. Returns false when refused without asking: a web scheme, or no local window (a page
 * streamed from a server must never launch apps on that server).
 */
export function requestBrowserExternalAppLaunch(args: {
  context: { browserPageId: string; renderer: Electron.WebContents } | null
  /** The page or popup contents that asked. */
  requester: Electron.WebContents
  rawUrl: string | undefined
  /** URL of the frame that asked; null shows the prompt without naming a site. */
  requestingUrl: () => string | null
}): boolean {
  const url = toBrowserExternalAppUrl(args.rawUrl)
  const { context } = args
  if (!url || !context || context.renderer.isDestroyed()) {
    return false
  }
  if (requestersAwaitingInput.has(args.requester.id)) {
    return true
  }
  // Why: one prompt per page, so a page looping a deep link cannot stack dialogs.
  for (const pending of pendingLaunches.values()) {
    if (pending.browserPageId === context.browserPageId) {
      return true
    }
  }
  const requestId = randomUUID()
  const request: BrowserExternalAppRequest = {
    requestId,
    appName: externalAppName(url.href),
    scheme: url.protocol.slice(0, -1),
    origin: requestingOrigin(args.requestingUrl())
  }
  pendingLaunches.set(requestId, {
    url: url.href,
    browserPageId: context.browserPageId,
    requester: args.requester,
    renderer: context.renderer,
    timer: setTimeout(() => {
      const expired = closePendingLaunch(requestId)
      if (expired) {
        silenceUntilInput(expired.requester)
      }
    }, BROWSER_EXTERNAL_APP_PROMPT_TIMEOUT_MS)
  })
  try {
    context.renderer.send('browser:external-app-requested', request)
  } catch {
    dropPendingLaunch(requestId)
    return false
  }
  return true
}

export async function respondToBrowserExternalAppRequest(
  sender: Electron.WebContents,
  response: BrowserExternalAppResponse
): Promise<BrowserExternalAppResponseResult> {
  if (
    !response ||
    typeof response.requestId !== 'string' ||
    typeof response.open !== 'boolean' ||
    pendingLaunches.get(response.requestId)?.renderer.id !== sender.id
  ) {
    return 'rejected'
  }
  const pending = dropPendingLaunch(response.requestId)
  if (!pending) {
    return 'rejected'
  }
  if (!response.open) {
    silenceUntilInput(pending.requester)
    return 'answered'
  }
  try {
    await shell.openExternal(pending.url)
    return 'answered'
  } catch (error) {
    console.warn('[browser] Could not open link in another app:', error)
    return 'launch-failed'
  }
}
