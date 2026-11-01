import { useCallback, useEffect, useRef, useState } from 'react'
import { View, type LayoutChangeEvent } from 'react-native'
import { MobileLocalBrowser } from '../browser/MobileLocalBrowser'
import { MobileLocalBrowserFullScreen } from '../browser/MobileLocalBrowserFullScreen'
import { MobileLocalBrowserToast } from '../browser/MobileLocalBrowserToast'
import type { MobileBrowserViewMode } from '../browser/browser-screencast-request'
import {
  canRenderBrowserLocally,
  useMobileBrowserLocalTunnel
} from '../browser/use-mobile-browser-local-tunnel'
import {
  browserLocalParamsSchema,
  browserViewParamsSchema,
  type BridgeBrowserViewEnding,
  type BridgeBrowserViewFrame
} from '../mobile-web-shell/bridge/bridge-native-verbs'
import { BridgeNativeVerbRefusedError } from '../mobile-web-shell/bridge-host-errors'
import {
  loadBrowserDrawing,
  type MobileBrowserDrawing,
  type MobileLocalBrowserNetwork
} from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useHostClient } from '../transport/host-client-hooks'

type Tab = {
  worktreeId: string
  url: string
  viewMode: MobileBrowserViewMode
  network: MobileLocalBrowserNetwork
}

type Placed = Tab & {
  id: string
  frame: BridgeBrowserViewFrame
  // Bumped when full screen hands a page back, so the placed view reopens it.
  generation: number
  end: (ending: BridgeBrowserViewEnding) => void
}

type FullScreen = Tab & { fromPlaced: boolean }

function settingNetwork(drawing: MobileBrowserDrawing): MobileLocalBrowserNetwork {
  return drawing === 'phone' ? 'phone' : 'host'
}

/**
 * Serves native.browser.local (the tab full screen) and native.browser.view (a native web view placed over the
 * page's pane), both drawn by this app over the served page.
 */
export function useNativeLocalBrowser(
  hostId: string,
  sessionId: string | null
): {
  serve: (params: unknown) => Promise<unknown>
  serveView: (params: unknown) => Promise<unknown>
  onPageLayout: (event: LayoutChangeEvent) => void
  overlay: React.JSX.Element | null
} {
  useMobileColorScheme()
  const { client } = useHostClient(hostId)
  const [fullScreen, setFullScreen] = useState<FullScreen | null>(null)
  const [placed, setPlaced] = useState<Placed | null>(null)
  const placedRef = useRef<Placed | null>(null)
  // The show the page wants now; a hide that arrives while its show is starting clears it.
  const wanted = useRef<string | null>(null)
  // Moves the page sends while that show is starting; the view opens at the latest one.
  const startingFrame = useRef<BridgeBrowserViewFrame | null>(null)
  // The placed tab's page, layout and network as the user changes them.
  const live = useRef<Tab | null>(null)
  const [pageOrigin, setPageOrigin] = useState({ x: 0, y: 0 })
  const [toast, setToast] = useState<string | null>(null)
  const dismissToast = useCallback(() => setToast(null), [])

  const place = useCallback((next: Placed | null) => {
    placedRef.current = next
    setPlaced(next)
  }, [])
  const endPlaced = useCallback(
    (ending: BridgeBrowserViewEnding) => {
      placedRef.current?.end(ending)
      live.current = null
      place(null)
    },
    [place]
  )

  // A new page document starts with nothing drawn over it.
  useEffect(() => {
    return () => {
      endPlaced('hidden')
      setFullScreen(null)
    }
  }, [endPlaced, sessionId])

  const requireLocal = useCallback(() => {
    if (!canRenderBrowserLocally(client)) {
      throw new BridgeNativeVerbRefusedError(
        'native_browser_unsupported',
        'this phone cannot draw pages itself'
      )
    }
  }, [client])

  const serve = useCallback(
    async (params: unknown) => {
      const parsed = browserLocalParamsSchema.parse(params)
      requireLocal()
      const network = settingNetwork(await loadBrowserDrawing())
      setFullScreen({
        worktreeId: parsed.worktreeId,
        url: parsed.url,
        viewMode: parsed.viewMode ?? 'mobile',
        network,
        fromPlaced: false
      })
      return {}
    },
    [requireLocal]
  )

  const serveView = useCallback(
    async (params: unknown) => {
      const parsed = browserViewParamsSchema.parse(params)
      const current = placedRef.current
      if (parsed.action === 'move') {
        if (current?.id === parsed.id) {
          place({ ...current, frame: parsed.frame })
        } else if (wanted.current === parsed.id) {
          startingFrame.current = parsed.frame
        }
        return {}
      }
      if (parsed.action === 'hide') {
        if (wanted.current === parsed.id) {
          wanted.current = null
        }
        if (current?.id === parsed.id) {
          endPlaced('hidden')
        }
        return {}
      }
      requireLocal()
      wanted.current = parsed.id
      startingFrame.current = null
      const drawing = await loadBrowserDrawing()
      if (wanted.current !== parsed.id) {
        return { ended: 'hidden' }
      }
      if (!parsed.network && drawing === 'stream') {
        return { ended: 'setting' }
      }
      endPlaced('replaced')
      return new Promise<{ ended: BridgeBrowserViewEnding }>((resolve) => {
        const tab = {
          worktreeId: parsed.worktreeId,
          url: parsed.url,
          viewMode: parsed.viewMode,
          network: parsed.network ?? settingNetwork(drawing)
        }
        live.current = tab
        place({
          ...tab,
          id: parsed.id,
          frame: startingFrame.current ?? parsed.frame,
          generation: 0,
          end: (ended) => resolve({ ended })
        })
        if (parsed.fullScreen) {
          setFullScreen({ ...tab, fromPlaced: true })
        }
      })
    },
    [endPlaced, place, requireLocal]
  )

  const onPageLayout = useCallback((event: LayoutChangeEvent) => {
    const { x, y } = event.nativeEvent.layout
    setPageOrigin((current) => (current.x === x && current.y === y ? current : { x, y }))
  }, [])

  // One tunnel serves the placed view and full screen: the host holds one per connection.
  const tunnelWorktreeId = fullScreen?.worktreeId ?? placed?.worktreeId ?? ''
  const sharesTunnel = placed !== null && placed.worktreeId === tunnelWorktreeId
  const tunnel = useMobileBrowserLocalTunnel(
    client,
    hostId,
    tunnelWorktreeId,
    fullScreen?.network === 'host' || (sharesTunnel && placed.network === 'host')
  )

  if (!client) {
    return { serve, serveView, onPageLayout, overlay: null }
  }
  const visible =
    placed !== null &&
    placed.frame.width > 0 &&
    placed.frame.height > 0 &&
    fullScreen?.fromPlaced !== true
  const updateLive = (change: Partial<Tab>): void => {
    live.current = live.current && { ...live.current, ...change }
  }
  const overlay = (
    <>
      {placed && (
        <View
          // Kept mounted while hidden so the page, its sign-in and scroll position survive.
          style={[
            styles.placed,
            {
              left: pageOrigin.x + placed.frame.x,
              top: pageOrigin.y + placed.frame.y,
              width: placed.frame.width,
              height: placed.frame.height
            },
            !visible && styles.hidden
          ]}
        >
          <MobileLocalBrowser
            key={`${placed.worktreeId}:${placed.generation}`}
            client={client}
            hostId={hostId}
            worktreeId={placed.worktreeId}
            initialUrl={placed.url}
            initialNetwork={placed.network}
            initialViewMode={placed.viewMode}
            tunnel={sharesTunnel ? tunnel : undefined}
            onViewModeChange={(viewMode) => updateLive({ viewMode })}
            onNetworkChange={(network) => {
              updateLive({ network })
              const current = placedRef.current
              if (current) {
                place({ ...current, network })
              }
            }}
            onUrlChange={(url) => updateLive({ url })}
            fullScreen={{
              active: false,
              onToggle: () => setFullScreen({ ...(live.current ?? placed), fromPlaced: true })
            }}
            pending={null}
            onStreamFromHost={() => endPlaced('streamed')}
            onHostTunnelFailed={() => endPlaced('failed')}
            onToast={setToast}
          />
          <MobileLocalBrowserToast message={toast} onDismiss={dismissToast} />
        </View>
      )}
      {fullScreen && (
        <MobileLocalBrowserFullScreen
          client={client}
          hostId={hostId}
          worktreeId={fullScreen.worktreeId}
          url={fullScreen.url}
          network={fullScreen.network}
          viewMode={fullScreen.viewMode}
          tunnel={tunnel}
          onNetworkChange={(network) =>
            setFullScreen((current) => current && { ...current, network })
          }
          onClose={(url) => {
            const current = placedRef.current
            if (fullScreen.fromPlaced && current) {
              const tab = { ...(live.current ?? current), url, network: fullScreen.network }
              live.current = tab
              place({ ...current, ...tab, generation: current.generation + 1 })
            }
            setFullScreen(null)
          }}
          onStreamFromHost={() => {
            if (fullScreen.fromPlaced) {
              endPlaced('streamedFullScreen')
            }
            setFullScreen(null)
          }}
        />
      )}
    </>
  )
  return { serve, serveView, onPageLayout, overlay }
}

const styles = themedStyleSheet(() => ({
  placed: {
    position: 'absolute',
    backgroundColor: colors.bgBase
  },
  hidden: {
    display: 'none'
  }
}))
