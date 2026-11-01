import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import { View } from 'react-native'
import { translate } from '../i18n/mobile-i18n'
import type { BridgeBrowserViewEnding } from '../mobile-web-shell/bridge/bridge-native-verbs'
import { useShellLocalBrowser } from '../platform/shell-local-browser'
import { loadBrowserDrawing, type MobileBrowserDrawing } from '../storage/preferences'
import type { MobileBrowserViewMode } from './browser-screencast-request'
import { isBlankBrowserUrl } from './browser-url'
import { mobileBrowserPaneStyles } from './mobile-browser-pane-styles'
import {
  getInitialMobileBrowserViewMode,
  saveMobileBrowserViewMode
} from './mobile-browser-view-mode-state'
import type { MobileBrowserFullScreenToggle } from './MobileBrowserDrawingButtons'
import { MobileBrowserFullScreenFrame } from './MobileBrowserFullScreenFrame'
import { MobileBrowserPane } from './MobileBrowserPane'
import { MobileBrowserPlacedLocal } from './MobileBrowserPlacedLocal'
import { MobileLocalBrowser } from './MobileLocalBrowser'
import {
  canRenderBrowserLocally,
  useMobileBrowserLocalTunnel
} from './use-mobile-browser-local-tunnel'

type Props = ComponentProps<typeof MobileBrowserPane> & { hostId: string }

// How long after the tab opens the host's first address still counts as the page it opened with.
const FIRST_ADDRESS_WAIT_MS = 10_000

function failureMessage(error: unknown): string {
  return translate('browser.surface.localFailed', 'Streaming from the host: {{reason}}', {
    reason: error instanceof Error ? error.message : String(error)
  })
}

/** Draws pages on the phone when the browser settings say so and it can, and streams the host's browser otherwise. */
export function MobileBrowserSurface({ hostId, ...paneProps }: Props): React.JSX.Element {
  const { client, worktreeId, tab, onToast } = paneProps
  const localPossible = canRenderBrowserLocally(client)
  // A page served into the app shell cannot host native views, so it asks the shell to draw them.
  const shell = useShellLocalBrowser()
  const drawing = useBrowserDrawing(localPossible)
  // How the user chose to draw this tab on its toolbar; the browser settings decide until then.
  const [picked, setPicked] = useState<MobileBrowserDrawing | null>(null)
  const [fullScreen, setFullScreen] = useState(false)
  // A served page's drawn tab opens in the shell's full screen when the user picked drawing from full screen.
  const [shellFullScreen, setShellFullScreen] = useState(false)
  // Bumped when the drawn tab must reopen: full screen came or went, or the tab came back from streaming.
  const [resume, setResume] = useState({ url: tab.url, generation: 0 })
  // A new tab opens blank and learns its address from the host a moment later; reopen the drawn tab there. The drawn
  // tab does not report where it went, so later addresses are the host's page moving, not the tab's first page. The
  // shell keeps a placed view open and decides itself, so the placed view is not reopened here.
  const [openedAt] = useState(() => Date.now())
  const placesViews = shell.placed !== null
  useEffect(() => {
    if (isBlankBrowserUrl(tab.url) || Date.now() - openedAt > FIRST_ADDRESS_WAIT_MS) {
      return
    }
    setResume((current) =>
      isBlankBrowserUrl(current.url)
        ? { url: tab.url, generation: current.generation + (placesViews ? 0 : 1) }
        : current
    )
  }, [openedAt, placesViews, tab.url])
  const mode = picked ?? (localPossible ? drawing : null)
  // The host serves one tunnel per connection, so it outlives the drawn tab moving in and out of full screen.
  const tunnel = useMobileBrowserLocalTunnel(client, hostId, worktreeId, mode === 'host')
  // The streamed pane and the drawn tab share the page's desktop or mobile layout.
  const viewMode = (): ReturnType<typeof getInitialMobileBrowserViewMode> =>
    getInitialMobileBrowserViewMode(worktreeId, tab.browserPageId, tab.url)

  const choose = (next: MobileBrowserDrawing): void => {
    if (next !== 'stream' && (picked ?? mode) === 'stream') {
      // The streamed page is where the drawn tab picks up.
      setResume((current) => ({
        url: isBlankBrowserUrl(tab.url) ? current.url : tab.url,
        generation: current.generation + 1
      }))
    }
    setPicked(next)
  }
  const toggleFullScreen: MobileBrowserFullScreenToggle = {
    active: fullScreen,
    onToggle: () => {
      setResume((current) => ({ ...current, generation: current.generation + 1 }))
      setFullScreen((current) => !current)
    }
  }
  const onHostTunnelFailed = useCallback(
    (reason: string) => {
      setPicked('stream')
      onToast(failureMessage(reason))
    },
    [onToast]
  )
  const inFullScreen = (content: React.JSX.Element): React.JSX.Element =>
    fullScreen ? (
      <>
        <View style={mobileBrowserPaneStyles.root} />
        <MobileBrowserFullScreenFrame onRequestClose={toggleFullScreen.onToggle}>
          {content}
        </MobileBrowserFullScreenFrame>
      </>
    ) : (
      content
    )
  const streamed = (offer: ComponentProps<typeof MobileBrowserPane>['drawing']) =>
    inFullScreen(
      <MobileBrowserPane
        {...paneProps}
        bottomInset={fullScreen ? 0 : paneProps.bottomInset}
        drawing={offer}
      />
    )

  if (localPossible && client) {
    if (mode === null) {
      return <View style={mobileBrowserPaneStyles.root} />
    }
    if (mode === 'stream') {
      return streamed({ onDrawingChange: choose, fullScreen: toggleFullScreen })
    }
    return inFullScreen(
      <MobileLocalBrowser
        key={resume.generation}
        client={client}
        hostId={hostId}
        worktreeId={worktreeId}
        initialUrl={resume.url}
        initialNetwork={mode}
        tunnel={tunnel}
        onNetworkChange={choose}
        initialViewMode={viewMode()}
        onViewModeChange={(next) => saveMobileBrowserViewMode(worktreeId, tab.browserPageId, next)}
        onUrlChange={(url) => setResume((current) => ({ ...current, url }))}
        fullScreen={toggleFullScreen}
        // The proxy starts in milliseconds; streaming meanwhile would open a screencast only to drop it.
        pending={<View style={mobileBrowserPaneStyles.root} />}
        onStreamFromHost={() => choose('stream')}
        onHostTunnelFailed={onHostTunnelFailed}
        onToast={onToast}
      />
    )
  }

  const placed = shell.placed
  if (placed) {
    if (picked !== 'stream') {
      // The shell draws full screen itself; the page streams there only after the user picks streaming in it.
      const onEnded = (ending: BridgeBrowserViewEnding, leftIn?: MobileBrowserViewMode): void => {
        if (leftIn) {
          saveMobileBrowserViewMode(worktreeId, tab.browserPageId, leftIn)
        }
        setShellFullScreen(false)
        if (ending !== 'hidden') {
          setPicked('stream')
          setFullScreen(ending === 'streamedFullScreen')
        }
      }
      return (
        <MobileBrowserPlacedLocal
          key={resume.generation}
          placed={placed}
          worktreeId={worktreeId}
          url={resume.url}
          viewMode={viewMode()}
          network={picked ?? undefined}
          fullScreen={shellFullScreen}
          onEnded={onEnded}
          onRefused={(error) => {
            setPicked('stream')
            onToast(failureMessage(error))
          }}
        />
      )
    }
    return streamed({
      onDrawingChange: (next) => {
        choose(next)
        // The shell takes the drawn tab full screen; the page holds its place inline under the shell's view.
        setShellFullScreen(fullScreen)
        setFullScreen(false)
      },
      fullScreen: toggleFullScreen
    })
  }
  const openFullScreen = shell.openFullScreen
  return (
    <MobileBrowserPane
      {...paneProps}
      drawing={
        openFullScreen
          ? {
              onDrawingChange: (next) => {
                if (next !== 'stream') {
                  void openFullScreen({ worktreeId, url: tab.url }).catch((error: unknown) =>
                    onToast(failureMessage(error))
                  )
                }
              },
              fullScreen: null
            }
          : undefined
      }
    />
  )
}

// The native app reads the browser settings itself; a served page leaves that to the shell.
function useBrowserDrawing(localPossible: boolean): MobileBrowserDrawing | null {
  const [drawing, setDrawing] = useState<MobileBrowserDrawing | null>(null)
  useEffect(() => {
    if (!localPossible) {
      return
    }
    let active = true
    void loadBrowserDrawing().then((saved) => {
      if (active) {
        setDrawing(saved)
      }
    })
    return () => {
      active = false
    }
  }, [localPossible])
  return drawing
}
