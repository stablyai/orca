import { useCallback, useEffect, useState, type ComponentProps } from 'react'
import { View } from 'react-native'
import { translate } from '../i18n/mobile-i18n'
import { useShellLocalBrowser } from '../platform/shell-local-browser'
import { loadBrowserDrawing, type MobileBrowserDrawing } from '../storage/preferences'
import { isBlankBrowserUrl } from './browser-url'
import { mobileBrowserPaneStyles } from './mobile-browser-pane-styles'
import {
  getInitialMobileBrowserViewMode,
  saveMobileBrowserViewMode
} from './mobile-browser-view-mode-state'
import { MobileBrowserPane } from './MobileBrowserPane'
import { MobileBrowserPlacedLocal } from './MobileBrowserPlacedLocal'
import { MobileLocalBrowser } from './MobileLocalBrowser'
import { MobileLocalBrowserFullScreen } from './MobileLocalBrowserFullScreen'
import { canRenderBrowserLocally } from './use-mobile-browser-local-tunnel'

type Props = ComponentProps<typeof MobileBrowserPane> & { hostId: string }

function failureMessage(error: unknown): string {
  return translate('browser.surface.localFailed', 'Streaming from the host: {{reason}}', {
    reason: error instanceof Error ? error.message : String(error)
  })
}

/** Draws pages on the phone when the browser settings say so and it can, and streams the host's browser otherwise. */
export function MobileBrowserSurface({ hostId, ...paneProps }: Props): React.JSX.Element {
  const { client, worktreeId, tab, onToast } = paneProps
  // This tab streams until it is opened again: the user chose it, the tunnel failed, or the shell's settings stream tabs.
  const [streamed, setStreamed] = useState(false)
  const localPossible = canRenderBrowserLocally(client)
  // A page served into the app shell cannot host native views, so it asks the shell to draw them.
  const shell = useShellLocalBrowser()
  const drawing = useBrowserDrawing(localPossible)
  const [fullScreen, setFullScreen] = useState<{ url: string; fromDrawn: boolean } | null>(null)
  // Bumped when full screen hands a page back, so the drawn tab reopens it.
  const [resume, setResume] = useState({ url: tab.url, generation: 0 })
  // A new tab opens blank and learns its address from the host a moment later; reopen the drawn tab there.
  useEffect(() => {
    if (!isBlankBrowserUrl(tab.url)) {
      setResume((current) =>
        isBlankBrowserUrl(current.url)
          ? { url: tab.url, generation: current.generation + 1 }
          : current
      )
    }
  }, [tab.url])
  // The streamed pane and the drawn tab share the page's desktop or mobile layout.
  const viewMode = (): ReturnType<typeof getInitialMobileBrowserViewMode> =>
    getInitialMobileBrowserViewMode(worktreeId, tab.browserPageId, tab.url)

  const stream = (): void => setStreamed(true)
  const onHostTunnelFailed = useCallback(
    (reason: string) => {
      setStreamed(true)
      onToast(failureMessage(reason))
    },
    [onToast]
  )

  if (localPossible && client) {
    if (drawing === null) {
      return <View style={mobileBrowserPaneStyles.root} />
    }
    const fullScreenView = fullScreen && (
      <MobileLocalBrowserFullScreen
        client={client}
        hostId={hostId}
        worktreeId={worktreeId}
        url={fullScreen.url}
        network={drawing === 'phone' ? 'phone' : 'host'}
        viewMode={viewMode()}
        onClose={(url) => {
          if (fullScreen.fromDrawn) {
            setResume((current) => ({ url, generation: current.generation + 1 }))
          }
          setFullScreen(null)
        }}
        onStreamFromHost={() => {
          setFullScreen(null)
          stream()
        }}
      />
    )
    if (!streamed && drawing !== 'stream') {
      return (
        <>
          <MobileLocalBrowser
            key={resume.generation}
            client={client}
            hostId={hostId}
            worktreeId={worktreeId}
            initialUrl={resume.url}
            initialNetwork={drawing}
            initialViewMode={viewMode()}
            onViewModeChange={(mode) =>
              saveMobileBrowserViewMode(worktreeId, tab.browserPageId, mode)
            }
            onUrlChange={(url) => setResume((current) => ({ ...current, url }))}
            fullScreen={{
              active: false,
              onToggle: () => setFullScreen({ url: resume.url, fromDrawn: true })
            }}
            // The proxy starts in milliseconds; streaming meanwhile would open a screencast only to drop it.
            pending={<View style={mobileBrowserPaneStyles.root} />}
            onStreamFromHost={stream}
            onHostTunnelFailed={onHostTunnelFailed}
            onToast={onToast}
          />
          {fullScreenView}
        </>
      )
    }
    return (
      <>
        <MobileBrowserPane
          {...paneProps}
          onRenderLocally={() => setFullScreen({ url: tab.url, fromDrawn: false })}
        />
        {fullScreenView}
      </>
    )
  }

  const placed = shell.placed
  if (placed && !streamed) {
    return (
      <MobileBrowserPlacedLocal
        key={resume.generation}
        placed={placed}
        worktreeId={worktreeId}
        url={resume.url}
        viewMode={viewMode()}
        onEnded={(ending) => {
          if (ending !== 'hidden') {
            stream()
          }
        }}
        onRefused={(error) => {
          stream()
          onToast(failureMessage(error))
        }}
      />
    )
  }
  const openFullScreen = shell.openFullScreen
  return (
    <MobileBrowserPane
      {...paneProps}
      onRenderLocally={
        openFullScreen
          ? () =>
              void openFullScreen({
                worktreeId,
                url: tab.url,
                // Only shells that place views take a layout.
                ...(placed ? { viewMode: viewMode() } : {})
              }).catch((error: unknown) => onToast(failureMessage(error)))
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
