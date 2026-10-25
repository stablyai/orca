import { app, shell } from 'electron'

import { DOC_PREVIEW_SCHEME } from '../../shared/doc-preview-scheme'
import {
  browserPagePromptOrigin,
  openBrowserPagePrompt,
  type BrowserPagePromptTarget
} from './browser-page-prompts'

// Deny web/internal schemes and Chrome's kDeniedSchemes (scripts, shell folders, shares).
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

/** Require a local window prompt so remote pages cannot launch apps on the server. */
export function requestBrowserExternalAppLaunch(args: {
  requester: Electron.WebContents
  target: BrowserPagePromptTarget | null
  rawUrl: string | undefined
  /** Null omits the site from the prompt. */
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
  // Keep blocking the link even when a quiet or busy page suppresses the prompt.
  return opening !== 'no-window'
}
