import { browserManager } from './browser-manager'
import { openBrowserPagePrompt } from './browser-page-prompts'
import {
  eligibleLocalNetworkOrigin,
  grantLocalNetworkAccess,
  hasLocalNetworkGrant,
  localNetworkGrantEpoch
} from './browser-local-network-grants'

/**
 * Answers a guest's request to reach apps and services on this device or local network. Allowed
 * only after the window showing the page says yes; the grant then covers the origin for the rest
 * of the app session in this partition. Anything not eligible, unanswered or unattended is denied.
 * `respond` runs exactly once.
 */
export function requestBrowserLocalNetworkAccess(args: {
  partition: string
  requester: Electron.WebContents
  /** URL of the frame that asked. */
  requestingUrl: string | undefined
  respond: (allowed: boolean) => void
}): void {
  const { partition, requester } = args
  let responded = false
  const respond = (allowed: boolean): void => {
    if (!responded) {
      responded = true
      args.respond(allowed)
    }
  }
  const topLevelUrl = requester.isDestroyed() ? null : requester.getURL()
  const origin = eligibleLocalNetworkOrigin(args.requestingUrl, topLevelUrl)
  if (!origin) {
    respond(false)
    return
  }
  if (hasLocalNetworkGrant(partition, origin)) {
    respond(true)
    return
  }
  const epoch = localNetworkGrantEpoch(partition)
  const opening = openBrowserPagePrompt({
    kind: 'local-network',
    requester,
    target: browserManager.resolvePagePromptTarget(requester),
    details: () => ({ origin }),
    // Why: a page probing several local ports at once gets one question.
    coalesceKey: origin,
    parseAnswer: (value) => (value === true ? true : undefined),
    settle: (allowed) => {
      respond(allowed === true && grantLocalNetworkAccess(partition, origin, epoch))
    }
  })
  // Why: settle never runs for a refused or windowless page, and the page must not wait on it.
  if (opening !== 'prompting') {
    respond(false)
  }
}

/**
 * Answers `navigator.permissions.query`: true only for an origin the user already allowed.
 *
 * Why this also asks: Electron turns off Chromium's Local Network Access checks (shell/browser/feature_list.cc),
 * so a fetch to 127.0.0.1 never raises a permission request and pages such as Okta FastPass only read this
 * answer. An eligible page without a grant gets the prompt now; the answer to this query stays denied,
 * and the page sees the grant on its next query.
 */
export function checkBrowserLocalNetworkAccess(args: {
  partition: string
  webContents: Electron.WebContents | null
  requestingOrigin: string | undefined
  details: { requestingUrl?: string; embeddingOrigin?: string } | undefined
}): boolean {
  const { webContents, details } = args
  const requesting = details?.requestingUrl || args.requestingOrigin
  // Why: Electron 43 sets embeddingOrigin for main-frame queries too (a URL-ish string with a trailing
  // slash, e.g. "https://example.com/"), so it is not a cross-origin signal. eligibleLocalNetworkOrigin
  // parses both sides as URLs and compares origins, which rejects a cross-origin subframe.
  const topLevel =
    details?.embeddingOrigin ||
    (webContents && !webContents.isDestroyed() ? webContents.getURL() : '') ||
    requesting
  const origin = eligibleLocalNetworkOrigin(requesting, topLevel)
  if (origin === null) {
    return false
  }
  if (hasLocalNetworkGrant(args.partition, origin)) {
    return true
  }
  if (webContents && !webContents.isDestroyed()) {
    requestBrowserLocalNetworkAccess({
      partition: args.partition,
      requester: webContents,
      requestingUrl: requesting,
      respond: () => {}
    })
  }
  return false
}
