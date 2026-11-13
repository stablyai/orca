// Web shell entry for the phone’s h/[hostId] route tree, packaged by build:mobile-web.
import { useEffect, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import type { QueryClient } from '@tanstack/react-query'
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
import {
  automationCatalogReadResultSchema,
  BRIDGE_AUTOMATION_CATALOG_VERB,
  storageReadResultSchema
} from '../src/mobile-web-shell/bridge/bridge-native-verbs'
import { BRIDGE_HOST_CATALOGS_GRANT } from '../src/mobile-web-shell/bridge/bridge-frame-fields'
import {
  publishPageStorage,
  refreshPageTerminalSettings
} from '../src/mobile-web-shell/bridge/page-async-storage'
import {
  createPageDeviceStore,
  publishPageDeviceStore
} from '../src/mobile-web-shell/bridge/page-device-store'
import {
  RouteScreenPaintProvider,
  createRouteScreenPaintReporter
} from '../src/mobile-web-shell/bridge/page-first-paint'
import { PageFaultBoundary } from '../src/mobile-web-shell/bridge/page-fault-boundary'
import type { BridgeUiLocale } from '../src/mobile-web-shell/bridge/bridge-envelope'
import { BRIDGE_OPEN_ROUTE_PARAM } from '../src/mobile-web-shell/bridge/bridge-route-update'
import { activateMobileUiLocale, subscribeMobileUiLanguage } from '../src/i18n/mobile-i18n'
import { startPageLocaleCatalogs } from '../src/i18n/page-locale-catalog-source'
import { getUiIntlLocale } from '../src/i18n/ui-intl-locale'
import { readDeviceUiLocaleTags, resolveUiLocaleFromTags } from '../src/i18n/system-ui-locale'
import { publishPageHostProfile } from '../src/mobile-web-shell/bridge/page-host-profile'
import { publishExternalLinkOpener } from '../src/platform/external-links/external-link.web'
import { publishHapticsNotifier } from '../src/platform/haptics/haptics.web'
import { startBlurringOnKeyboardClose } from '../src/platform/keyboard/keyboard-close-blur.web'
import { publishShellKeyboardSource } from '../src/platform/keyboard/keyboard-occlusion.web'
// Select the page-client provider explicitly; the builder aliases extensionless screen imports to this same web module.
import { RpcClientProvider } from '../src/transport/connection/client-context.web'
import { OrcaQueryProvider } from '../src/query/orca-query-provider.web'
import { createOrcaQueryClient } from '../src/query/orca-query-client'
import {
  awaitFirstPaintRestore,
  startPageQueryPersistence
} from '../src/query/page-query-persistence'
// Body replaced at build time: esbuild has no require.context, so the builder synthesizes one.
import routeContext from './route-manifest'
import { preloadBootRoutes } from './boot-route-preload'

// The h/ tree omits the native root provider, so supply ExpoRoot’s wrapper after init gives us a client.
// Router suspense handles pending chunks; rejected chunks belong to the outer fault boundary.
function createRootProviders(
  client: BridgeRpcClient,
  target: PageMountTarget,
  queryClient: QueryClient
) {
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
        <OrcaQueryProvider client={queryClient}>
          <RouteScreenPaintProvider report={reportRouteScreenPaint}>
            {children}
          </RouteScreenPaintProvider>
        </OrcaQueryProvider>
      </RpcClientProvider>
    )
  }
}

// The shell's `open` target paints first; a target that can't be parsed boots the document's own route.
function bootRoute(openTarget: string | undefined): URL {
  try {
    return new URL(openTarget ?? window.location.href, window.location.href)
  } catch {
    return new URL(window.location.href)
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
    const deviceStore = createPageDeviceStore(client)
    publishPageDeviceStore(deviceStore)
    // A shell that skipped the catalog chunks has the page read its catalog from the desktop; before the first load.
    if (session.grants.native.includes(BRIDGE_HOST_CATALOGS_GRANT)) {
      startPageLocaleCatalogs({ client, store: deviceStore })
    }
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
    // An open-target boot paints the shell's target first, so that is the screen to preload and restore.
    const route = bootRoute(session.route?.params?.[BRIDGE_OPEN_ROUTE_PARAM])
    const queryClient = createOrcaQueryClient()
    const { host } = session
    const automationRestore =
      host &&
      client.getState() !== 'connected' &&
      session.grants.native.includes(BRIDGE_AUTOMATION_CATALOG_VERB) &&
      route.pathname === `/h/${encodeURIComponent(host.id)}/automations`
        ? Promise.all([
            import('../src/automations/use-automation-catalog'),
            client.callNativeVerb(BRIDGE_AUTOMATION_CATALOG_VERB, {})
          ])
            .then(([{ restoreAutomationCatalog }, reply]) => {
              const snapshot = automationCatalogReadResultSchema.parse(reply.result)
              if (snapshot) {
                restoreAutomationCatalog(queryClient, host.id, snapshot)
              }
            })
            .catch(() => {})
        : null
    // One store read for the first screen's stored data, alongside the catalog and route loads.
    const firstPaintRestore = startPageQueryPersistence(
      queryClient,
      deviceStore,
      session.host?.id ?? '',
      route
    )
    client.onStorageUpdate(() => {
      const current = client.getShellSession()
      if (current !== null) {
        refreshPageTerminalSettings(current.storage, current.storageOversize)
      }
    })
    const bootRoutes = preloadBootRoutes(route.pathname)
    // Activation settles to English on failure and preloads settle either way, so the page always mounts.
    void Promise.all([settleLatest(() => uiLocaleActivation), bootRoutes])
      .then(() =>
        awaitFirstPaintRestore(Promise.all([firstPaintRestore, automationRestore]).then(() => {}))
      )
      .then(() =>
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
              wrapper={createRootProviders(client, target, queryClient)}
            />
          </PageFaultBoundary>
        )
      )
  },
  refuseUnroutedShell: () => {
    renderShellTooOldPanel(container)
  }
})
