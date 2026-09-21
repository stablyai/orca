// Route A web entry: mounts the phone's h/[hostId] route tree on react-native-web.
// Dark: built by `build:mobile-web:app` into out/mobile-web-app, shipped by nothing until C1.
import { useEffect, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { ExpoRoot } from 'expo-router'
import type { BridgeRpcClient } from '../src/mobile-web-shell/bridge/bridge-rpc-client'
import {
  bootstrapShellPage,
  createShellPageClient,
  stampPageMountState,
  type PageMountTarget
} from '../src/mobile-web-shell/bridge/page-bootstrap'
import { publishPageStorage } from '../src/mobile-web-shell/bridge/page-async-storage'
import { PageFaultBoundary } from '../src/mobile-web-shell/bridge/page-fault-boundary'
import { publishPageHostProfile } from '../src/mobile-web-shell/bridge/page-host-profile'
import { publishExternalLinkOpener } from '../src/platform/external-link.web'
import { publishHapticsNotifier } from '../src/platform/haptics.web'
// Named with its extension: this entry is the web build's and the provider it needs is the web
// sibling's, which takes the page's client. The screens below still import `./client-context`
// and reach the same module, because the builder resolves both specifiers to the same file.
import { RpcClientProvider } from '../src/transport/client-context.web'
// Body replaced at build time: esbuild has no require.context, so the builder synthesizes one.
import routeContext from './route-manifest'

// The route tree starts at app/h, below the native root layout that owns the provider, so the
// page supplies it here through ExpoRoot's own wrapper rather than mounting the native shell.
// No suspense boundary: expo-router wraps every screen in its own, which is what catches the
// route chunks the manifest defers. A chunk that never arrives is a rejection rather than a wait,
// and that is the boundary below's, not suspense's.
// A factory because the client is not in scope until `init` lands, and ExpoRoot takes a component.
function createRootProviders(client: BridgeRpcClient, target: PageMountTarget) {
  return function RootProviders({ children }: PropsWithChildren) {
    // Effects run child-first, so 'mounted' lands only after the router tree below this wrapper
    // has committed. The tree is rendered once, with a ready client, so there is one such commit.
    useEffect(() => {
      stampPageMountState(target, 'mounted')
    }, [])
    return <RpcClientProvider client={client}>{children}</RpcClientProvider>
  }
}

/**
 * The whole page for a shell that opened it and then named no screen.
 *
 * Built as elements rather than markup, and outside React: the route tree is exactly what cannot
 * be mounted here, and a panel that needed it would be a second way to fail. The copy names the
 * one thing that fixes it, because nothing on this device will.
 */
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
stampPageMountState(target, 'started')

bootstrapShellPage({
  target,
  client: createShellPageClient(),
  replaceUrl: (href) => {
    history.replaceState(null, '', href)
  },
  mount: (client, session) => {
    // Before the first render, because both are read from effects that run on it: the host store is
    // a plain async function with no provider above it, and the first list paints its pins.
    publishPageHostProfile(session.host)
    // Same reason, and the same shape: the seam is a plain function in render trees the provider
    // does not wrap, so the client's notify is published rather than read from context.
    publishExternalLinkOpener((url) => client.notifyExternalLink(url))
    // The same shape again, and for the same reason: every haptic on this page is played from a
    // plain function inside a row's press handler, which no provider wraps.
    publishHapticsNotifier((kind) => client.notifyHaptics(kind))
    // Scoped to the host `init` named: with none, no key is writable, which is the right answer
    // for a shell too old to say whose list this is.
    publishPageStorage(
      session.storage,
      (key, value) => client.notifyStorageWrite(key, value),
      session.host?.id ?? '',
      session.route?.pathname ?? '',
      session.storageOversize
    )
    createRoot(container).render(
      // Above `ExpoRoot`, not inside its wrapper: a route this bundle cannot resolve or import
      // throws where the router renders it, and a boundary below the router never sees that.
      <PageFaultBoundary
        onFault={(error) => {
          client.notifyPageFault(error)
        }}
      >
        <ExpoRoot
          context={routeContext}
          // The same URL the line above just wrote, handed over rather than left to be read:
          // ExpoRoot snapshots `window.location.href` when its module is imported, which is before
          // any frame has crossed the bridge, so what it captured on its own is the `/` the shell
          // serves.
          location={new URL(window.location.href)}
          wrapper={createRootProviders(client, target)}
        />
      </PageFaultBoundary>
    )
  },
  refuseUnroutedShell: () => {
    renderShellTooOldPanel(container)
  }
})
