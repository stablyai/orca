// Route A web entry: mounts the phone's h/[hostId] route tree on react-native-web.
// Dark: built by `build:mobile-web:app` into out/mobile-web-app, shipped by nothing until C1.
import { useEffect, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { ExpoRoot } from 'expo-router'
import { RpcClientProvider } from '../src/transport/client-context'
// Body replaced at build time: esbuild has no require.context, so the builder synthesizes one.
import routeContext from './route-manifest'

// Progress of the mount, in one attribute, so the render check can tell a page that never ran
// its script from one that ran it and threw. Effects run child-first, so 'mounted' lands only
// after the router tree below this wrapper has committed.
const MOUNT_STATE_ATTRIBUTE = 'orcaWebEntry'

// The route tree starts at app/h, below the native root layout that owns the provider, so the
// page supplies it here through ExpoRoot's own wrapper rather than mounting the native shell.
// No suspense boundary: expo-router wraps every screen in its own, which is what catches the
// route chunks the manifest defers.
function RootProviders({ children }: PropsWithChildren) {
  useEffect(() => {
    document.documentElement.dataset[MOUNT_STATE_ATTRIBUTE] = 'mounted'
  }, [])
  return <RpcClientProvider>{children}</RpcClientProvider>
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('[orca-mobile-web-app] #root missing')
}
document.documentElement.dataset[MOUNT_STATE_ATTRIBUTE] = 'started'
createRoot(container).render(<ExpoRoot context={routeContext} wrapper={RootProviders} />)
