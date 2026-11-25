import * as ExpoCrypto from 'expo-crypto'
import { connect } from '../../transport/rpc/direct-rpc-connect'
import { readProbedHostStatus } from '../../transport/connection/host-status-probe-operations'
import type { HostStatusReply } from '../../transport/hosts/host-status-reply-schema'
import { MOBILE_WEB_BROWSER_MANIFEST_PATH } from '../../../../src/shared/mobile-web-bundle/mobile-web-browser-path'
import { MobileWebBundleManifestReadSchema } from '../../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { encodeBase64Url } from '../../transport/encryption/mobile-session-id-encoding'
import { readDeviceUiLocaleTags, resolveUiLocaleFromTags } from '../../i18n/system-ui-locale'
import { createBridgeHost } from '../host-bridge/bridge-host'
import type { BridgeHost } from '../host-bridge/bridge-host-contract'
import { routeViewOf } from '../routing/page-route-policy'
import type { OrcaBridgePageChannel } from '../bridge/page-lifecycle/orca-bridge-page-channel'
import type { BridgeInitRoute } from '../bridge/protocol/bridge-init-route'
import {
  clipboardWriteParamsSchema,
  storageReadParamsSchema,
  type BridgeNativeVerb
} from '../bridge/native-capabilities/bridge-native-verbs'
import { readBrowserShellPairing, writeBrowserShellPairing } from './browser-shell-pairing'
import { exchangeBrowserShellTicket } from './browser-shell-ticket'
import { createBrowserShellHistory } from './browser-shell-history'
import { createBrowserShellStorage } from './browser-shell-storage'
import { readBrowserSafeAreaInsets, readBrowserKeyboardInset } from './browser-shell-geometry'

// One host per document; the page's routes name it in the address bar.
const BROWSER_HOST_ID = 'web'

// What a browser tab can do; every other grant a route declares is withheld so the page's own
// missing-grant fallbacks take over (no camera, microphone, PDF viewer or key rail here).
const BROWSER_SHELL_GRANTS = [
  'navigate',
  'storage',
  'externalLink',
  'haptics',
  'screencastBinary',
  'native.storage.read'
]
// Browsers expose the clipboard only to HTTPS and localhost pages.
const CLIPBOARD_GRANTS = ['native.clipboard.write', 'native.clipboard.read']

function browserGrantFilter(): (grants: readonly string[]) => string[] {
  const held: ReadonlySet<string> = new Set(
    window.isSecureContext && navigator.clipboard
      ? [...BROWSER_SHELL_GRANTS, ...CLIPBOARD_GRANTS]
      : BROWSER_SHELL_GRANTS
  )
  return (grants) => grants.filter((grant) => held.has(grant))
}

/**
 * Plays the native shell's part for the page in a plain browser: pairs from the link, opens the
 * same E2EE connection the app does, and answers the page's bridge in-process through the app's
 * own bridge host. False when this document has no pairing, so the page shows why it cannot start.
 */
export async function installBrowserShell(): Promise<boolean> {
  const pairing = readBrowserShellPairing()
  if (pairing.kind === 'refused') {
    showBrowserShellRefusal(pairing.reason)
    return false
  }
  if (pairing.kind === 'none') {
    return false
  }
  const offer = pairing.fromLink
    ? await exchangeBrowserShellTicket(pairing.offer, BROWSER_HOST_ID)
    : pairing.offer
  if (offer !== pairing.offer) {
    writeBrowserShellPairing(offer)
  }
  const withBrowserGrants = browserGrantFilter()
  const manifest = MobileWebBundleManifestReadSchema.parse(
    await (await fetch(MOBILE_WEB_BROWSER_MANIFEST_PATH, { cache: 'no-cache' })).json()
  )
  const route = bootRouteFromLocation()
  const view = routeViewOf(manifest.routes, route.pathname)
  const client = connect(offer.endpoint, offer.deviceToken, offer.publicKeyB64, {
    hostId: BROWSER_HOST_ID,
    onLog: (entry) => {
      if (entry.level !== 'info') {
        console.warn('[browser-shell]', entry.message, entry.detail ?? '')
      }
    }
  })
  const storage = createBrowserShellStorage(globalThis.localStorage ?? null)
  let hostStatus: HostStatusReply | null = null
  const colorScheme = window.matchMedia('(prefers-color-scheme: light)')
  const tabHistory = createBrowserShellHistory(pairing.fromLink)

  const channel: OrcaBridgePageChannel = {
    // Deliver asynchronously in both directions, as a WebView does, so neither side re-enters the other.
    postMessage: (json) => {
      queueMicrotask(() => host.receive(json))
    },
    onmessage: null
  }

  const host: BridgeHost = createBridgeHost({
    client,
    buildId: manifest.buildId,
    sessionId: encodeBase64Url(ExpoCrypto.getRandomBytes(32)),
    route,
    pageRoutes: view.pageRoutes,
    pageRouteGrants: view.pageRouteGrants.map((pair) => ({
      pathname: pair.pathname,
      grants: withBrowserGrants(pair.grants)
    })),
    routeGrants: withBrowserGrants(view.routeGrants),
    ownsHostArea: view.ownsHostArea,
    readHostStatus: () => hostStatus,
    sessionEstablished: false,
    host: {
      id: BROWSER_HOST_ID,
      name: new URL(offer.endpoint).hostname,
      endpoint: offer.endpoint,
      lastConnected: Date.now()
    },
    safeAreaInsets: readBrowserSafeAreaInsets(),
    keyboardInset: readBrowserKeyboardInset(),
    colorScheme: colorScheme.matches ? 'light' : 'dark',
    uiLocale: resolveUiLocaleFromTags(readDeviceUiLocaleTags()),
    readClientIdentity: () => offer.deviceToken,
    readStorage: () => storage.readForInit(BROWSER_HOST_ID, route.pathname),
    onStorageWrite: storage.write,
    // A target outside this document opens as a new one; the server serves the page at every /h/ path.
    onNavigate: tabHistory.navigate,
    serveNativeVerb: (verb, params) => serveBrowserNativeVerb(verb, params, storage.read),
    onExternalLink: (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    onHaptic: () => {
      navigator.vibrate?.(10)
    },
    onNavigateBack: tabHistory.back,
    onPageFault: (error) => {
      console.error('[browser-shell] page fault', error)
    },
    onPageReady: () => {},
    onPagePainted: () => {},
    onPageBackClaim: () => {},
    onPageLocation: () => {},
    onRouteParamClear: () => {},
    onRouteRefused: (issue) => {
      console.error('[browser-shell] route refused', issue)
    },
    post: (json) => {
      queueMicrotask(() => channel.onmessage?.({ data: json }))
      return Promise.resolve()
    },
    onDiagnostic: (diagnostic) => {
      console.warn('[browser-shell]', diagnostic.kind, diagnostic)
    }
  })

  const scope: typeof globalThis & { orcaBridge?: OrcaBridgePageChannel } = globalThis
  scope.orcaBridge = channel

  // The app's compatibility gate reads status before it shows a page; here the desktop serves its
  // own page, so the status only has to be read, and is read again on every reconnect.
  const verifyHostStatus = async (): Promise<void> => {
    const landed = readProbedHostStatus(await client.sendRequest('status.get'))
    if (landed?.status) {
      hostStatus = landed.status
      host.publishHostStatus()
    }
  }
  client.onStateChange((state) => {
    if (state === 'connected') {
      void verifyHostStatus().catch((error: unknown) => {
        console.warn('[browser-shell] status.get failed', error)
      })
    }
  })
  if (client.getState() === 'connected') {
    void verifyHostStatus()
  }

  const publishGeometry = () => {
    host.publishSafeAreaInsets(readBrowserSafeAreaInsets())
    host.publishKeyboardInset(readBrowserKeyboardInset())
  }
  window.addEventListener('resize', publishGeometry)
  window.visualViewport?.addEventListener('resize', publishGeometry)
  colorScheme.addEventListener('change', () => {
    host.publishColorScheme(colorScheme.matches ? 'light' : 'dark')
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      client.notifyForeground('app-resume')
    }
  })
  return true
}

// The page rewrites the address to its route, so a reload or a cross-document hop lands here with it.
function bootRouteFromLocation(): BridgeInitRoute {
  const { pathname, search } = window.location
  const params = Object.fromEntries(new URLSearchParams(search))
  const routePathname = pathname.startsWith('/h/') ? pathname : `/h/${BROWSER_HOST_ID}`
  return Object.keys(params).length === 0
    ? { pathname: routePathname }
    : { pathname: routePathname, params }
}

async function serveBrowserNativeVerb(
  verb: BridgeNativeVerb,
  params: unknown,
  readStorage: (key: string) => string | null
): Promise<unknown> {
  switch (verb) {
    case 'native.clipboard.write':
      await navigator.clipboard.writeText(clipboardWriteParamsSchema.parse(params).value)
      return { written: true }
    case 'native.clipboard.read':
      return { value: await navigator.clipboard.readText() }
    case 'native.storage.read':
      return { value: readStorage(storageReadParamsSchema.parse(params).key) }
    // Never granted here, so the page takes its missing-grant path before asking; for deferred code
    // that is importing the diagram engine from /assets/ like any other chunk.
    case 'native.media.pick':
    case 'native.media.read':
    case 'native.media.release':
    case 'native.media.name':
    case 'native.audio.start':
    case 'native.audio.read':
    case 'native.audio.stop':
    case 'native.pdf.view':
    case 'native.image.act':
    case 'native.speech.act':
    case 'native.store.rows':
    case 'native.a11y.announce':
    case 'native.link.open':
    case 'native.bundle.deferred':
      throw new Error(`${verb} is not available in a browser`)
  }
}

// The page cannot start without a pairing, so say why instead of leaving a blank tab.
function showBrowserShellRefusal(reason: string): void {
  const notice = document.createElement('p')
  notice.setAttribute('role', 'alert')
  notice.textContent = reason
  notice.style.cssText =
    'position:fixed;inset:auto 16px 50% 16px;margin:0;font:16px/1.4 system-ui,sans-serif;' +
    'text-align:center;color:#e5e5e5;z-index:2147483647'
  document.body.appendChild(notice)
}
