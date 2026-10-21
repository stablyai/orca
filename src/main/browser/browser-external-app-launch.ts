import { app, shell } from 'electron'

import { DOC_PREVIEW_SCHEME } from '../../shared/doc-preview-scheme'
import {
  browserPagePromptOrigin,
  openBrowserPagePrompt,
  type BrowserPagePromptTarget
} from './browser-page-prompts'

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

async function launchExternalApp(url: string): Promise<'failed' | undefined> {
  try {
    await shell.openExternal(url)
    return undefined
  } catch (error) {
    console.warn('[browser] Could not open link in another app:', error)
    return 'failed'
  }
}

/**
 * Asks the window showing the page whether to open the link in its app; Orca launches it only on
 * a yes. Returns false when refused without asking: a web scheme, or no window on this machine (a
 * page streamed from a server must never launch apps on that server).
 */
export function requestBrowserExternalAppLaunch(args: {
  /** The page or popup contents that asked. */
  requester: Electron.WebContents
  target: BrowserPagePromptTarget | null
  rawUrl: string | undefined
  /** URL of the frame that asked; null shows the prompt without naming a site. */
  requestingUrl: () => string | null
}): boolean {
  const url = toBrowserExternalAppUrl(args.rawUrl)
  if (!url) {
    return false
  }
  const opening = openBrowserPagePrompt({
    kind: 'external-app',
    requester: args.requester,
    target: args.target,
    details: () => ({
      appName: externalAppName(url.href),
      scheme: url.protocol.slice(0, -1),
      origin: browserPagePromptOrigin(args.requestingUrl())
    }),
    parseAnswer: (value) => (value === true ? true : undefined),
    settle: (open) => (open ? launchExternalApp(url.href) : undefined)
  })
  // Why: a quiet or busy page still must not reach the link, so the caller keeps blocking it.
  return opening !== 'no-window'
}
