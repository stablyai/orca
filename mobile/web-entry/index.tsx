// Web shell entry for the phone’s h/[hostId] route tree, packaged by build:mobile-web.
import { useEffect, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { ExpoRoot } from 'expo-router'
import {
  applyMobileColorScheme,
  colors,
  getMobileColorScheme,
  subscribeMobileColorScheme
} from '../src/theme/mobile-theme'
import type { BridgeRpcClient } from '../src/mobile-web-shell/bridge/bridge-rpc-client'
import {
  bootstrapShellPage,
  createShellPageClient,
  stampPageMountState,
  type PageMountTarget
} from '../src/mobile-web-shell/bridge/page-bootstrap'
import { storageReadResultSchema } from '../src/mobile-web-shell/bridge/bridge-native-verbs'
import {
  publishPageStorage,
  refreshPageTerminalShortcuts
} from '../src/mobile-web-shell/bridge/page-async-storage'
import {
  RouteScreenPaintProvider,
  createRouteScreenPaintReporter
} from '../src/mobile-web-shell/bridge/page-first-paint'
import { PageFaultBoundary } from '../src/mobile-web-shell/bridge/page-fault-boundary'
import type { BridgeUiLocale } from '../src/mobile-web-shell/bridge/bridge-envelope'
import { activateMobileUiLocale, subscribeMobileUiLanguage } from '../src/i18n/mobile-i18n'
import { getUiIntlLocale } from '../src/i18n/ui-intl-locale'
import { readDeviceUiLocaleTags, resolveUiLocaleFromTags } from '../src/i18n/system-ui-locale'
import { publishPageHostProfile } from '../src/mobile-web-shell/bridge/page-host-profile'
import { publishExternalLinkOpener } from '../src/platform/external-link.web'
import { publishHapticsNotifier } from '../src/platform/haptics.web'
import { startBlurringOnKeyboardClose } from '../src/platform/keyboard-close-blur.web'
import { publishShellKeyboardSource } from '../src/platform/keyboard-occlusion.web'
// Select the page-client provider explicitly; the builder aliases extensionless screen imports to this same web module.
import { RpcClientProvider } from '../src/transport/client-context.web'
// Body replaced at build time: esbuild has no require.context, so the builder synthesizes one.
import routeContext from './route-manifest'

// The h/ tree omits the native root provider, so supply ExpoRoot’s wrapper after init gives us a client.
// Router suspense handles pending chunks; rejected chunks belong to the outer fault boundary.
function createRootProviders(client: BridgeRpcClient, target: PageMountTarget) {
  // Wait for the second frame before dropping the shell’s cover; a React commit alone proves no paint.
  const reportRouteScreenPaint = createRouteScreenPaintReporter(
    {
      requestFrame: (callback) => requestAnimationFrame(callback),
      cancelFrame: (handle) => {
        cancelAnimationFrame(handle)
      }
    },
    () => {
      client.notifyPagePainted()
    }
  )
  return function RootProviders({ children }: PropsWithChildren) {
    // Child-first effects prove router commit, possibly its suspense fallback; screen paint is reported separately.
    useEffect(() => {
      stampPageMountState(target, 'mounted')
    }, [])
    return (
      <RpcClientProvider client={client}>
        <RouteScreenPaintProvider report={reportRouteScreenPaint}>
          {children}
        </RouteScreenPaintProvider>
      </RpcClientProvider>
    )
  }
}

// Older shells send no language; follow the WebView's, which tracks the phone's.
function activatePageUiLocale(locale: BridgeUiLocale | null): Promise<void> {
  return activateMobileUiLocale(locale ?? resolveUiLocaleFromTags(readDeviceUiLocaleTags()))
}

// Mount after the newest activation, not a superseded one that settled first.
async function settleLatest(latest: () => Promise<void>): Promise<void> {
  let current: Promise<void>
  do {
    current = latest()
    await current
  } while (current !== latest())
}

// Build outside React because an unresolved route tree cannot mount its own recovery panel.
function renderShellTooOldPanel(container: HTMLElement): void {
  const panel = document.createElement('div')
  panel.setAttribute('role', 'alert')
  panel.style.cssText =
    'font:16px/1.5 system-ui,-apple-system,sans-serif;color:#e6e6e6;background:#141414;' +
    'min-height:100vh;display:flex;flex-direction:column;align-items:center;' +
    'justify-content:center;gap:8px;padding:24px;text-align:center'
  const title = document.createElement('div')
  title.style.cssText = 'font-weight:600'
  title.textContent = 'Update Orca to open this workspace'
  const body = document.createElement('div')
  body.style.cssText = 'color:#9a9a9a;font-size:14px'
  body.textContent = 'This version of the app cannot open the workspace it downloaded.'
  panel.append(title, body)
  container.replaceChildren(panel)
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('[orca-mobile-web-app] #root missing')
}
const target = document.documentElement
// Keep <html> transparent: overlay routes show the native screen through it, and the shell paints bgBase behind the rest.
function paintDocumentScheme(): void {
  target.style.setProperty('--muted-foreground', colors.textMuted)
  target.style.setProperty('--foreground', colors.textPrimary)
  target.style.colorScheme = getMobileColorScheme()
}
paintDocumentScheme()
subscribeMobileColorScheme(paintDocumentScheme)
// The WebView picks CJK glyph variants and hyphenation from <html lang>.
subscribeMobileUiLanguage(() => {
  target.lang = getUiIntlLocale()
})
stampPageMountState(target, 'started')

bootstrapShellPage({
  target,
  client: createShellPageClient(),
  replaceUrl: (href) => {
    history.replaceState(null, '', href)
  },
  mount: (client, session) => {
    // Apply before the first render so no component paints the default dark palette first.
    applyMobileColorScheme(session.colorScheme)
    client.onColorSchemeUpdate(applyMobileColorScheme)
    // Subscribe before the first catalog load so a switch during startup is not lost; the latest request wins.
    let uiLocaleActivation = activatePageUiLocale(session.uiLocale)
    client.onUiLocaleUpdate((locale) => {
      uiLocaleActivation = activatePageUiLocale(locale)
    })
    // Publish plain-function seams before first render because effects and initial list paint already read them.
    publishPageHostProfile(session.host)
    publishExternalLinkOpener((url) => client.notifyExternalLink(url))
    publishHapticsNotifier((kind) => client.notifyHaptics(kind))
    // Expose shell keyboard height to hooks and plain functions.
    publishShellKeyboardSource({
      read: () => client.getShellSession()?.keyboardInset ?? 0,
      subscribe: client.onKeyboardInsetUpdate
    })
    startBlurringOnKeyboardClose()
    // Without a host in init, leave every storage key unwritable for older shells.
    publishPageStorage(
      session.storage,
      (key, value) => client.notifyStorageWrite(key, value),
      session.host?.id ?? '',
      session.route?.pathname ?? '',
      session.storageOversize,
      session.ownsHostArea
        ? async (key) =>
            storageReadResultSchema.parse(
              (await client.callNativeVerb('native.storage.read', { key })).result
            ).value
        : null
    )
    client.onStorageUpdate(() => {
      const current = client.getShellSession()
      if (current !== null) {
        refreshPageTerminalShortcuts(current.storage, current.storageOversize)
      }
    })
    // Activation settles to English on failure, so the page always mounts.
    void settleLatest(() => uiLocaleActivation).then(() =>
      createRoot(container).render(
        // Catch outside ExpoRoot so route-resolution/import failures cannot bypass the page boundary.
        <PageFaultBoundary
          onFault={(error) => {
            client.notifyPageFault(error)
          }}
        >
          <ExpoRoot
            context={routeContext}
            // Pass the post-init URL explicitly; ExpoRoot’s import-time location predates bridge frames and still names /.
            location={new URL(window.location.href)}
            wrapper={createRootProviders(client, target)}
          />
        </PageFaultBoundary>
      )
    )
  },
  refuseUnroutedShell: () => {
    renderShellTooOldPanel(container)
  }
})
