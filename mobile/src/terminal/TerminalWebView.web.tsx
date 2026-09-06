import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type MutableRefObject
} from 'react'
import { View } from 'react-native'
import { isTerminalQueryReply } from '../../../src/shared/terminal-query-reply'
import {
  activateTerminalWebUri,
  createTerminalWebLinkController
} from './terminal-web-link-provider'
import type {
  TerminalModes,
  TerminalWebViewHandle,
  TerminalWebViewProps
} from './terminal-webview-contract'
import { DEFAULT_TERMINAL_THEME } from './terminal-webview-html/theme'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import { createTerminalWebRendererRecovery } from './terminal-web-renderer-recovery'
import { createTerminalWebSelectionController } from './terminal-web-selection-controller'
import { createTerminalWebTextZoomController } from './terminal-web-text-zoom'

export type { TerminalWebViewHandle } from './terminal-webview-contract'

export const TerminalWebView = forwardRef<TerminalWebViewHandle, TerminalWebViewProps>(
  function TerminalWebView(props, ref) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const terminalRef = useRef<Terminal | null>(null)
    const fitRef = useRef<FitAddon | null>(null)
    const selectionRef = useRef<ReturnType<typeof createTerminalWebSelectionController> | null>(
      null
    )
    const linkRef = useRef<ReturnType<typeof createTerminalWebLinkController> | null>(null)
    const textZoomRef = useRef<ReturnType<typeof createTerminalWebTextZoomController> | null>(null)
    const rendererRef = useRef<ReturnType<typeof createTerminalWebRendererRecovery> | null>(null)
    const propsRef = useRef(props)
    useEffect(() => {
      propsRef.current = props
    }, [props])

    useEffect(() => {
      const container = containerRef.current
      if (!container) {
        return
      }
      const terminal = new Terminal(terminalOptions(propsRef))
      const fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(container)
      rendererRef.current = createTerminalWebRendererRecovery(terminal)
      terminalRef.current = terminal
      fitRef.current = fit
      fit.fit()
      selectionRef.current = createTerminalWebSelectionController({
        container,
        terminal,
        getProps: () => propsRef.current
      })
      linkRef.current = createTerminalWebLinkController({
        container,
        terminal,
        getProps: () => propsRef.current,
        cancelSelection: () => selectionRef.current?.cancelSelect()
      })
      textZoomRef.current = createTerminalWebTextZoomController({
        container,
        terminal,
        getProps: () => propsRef.current,
        onPinchStart: () => selectionRef.current?.cancelSelect()
      })
      notifyModes(terminal, propsRef)
      propsRef.current.onWebReady?.()

      const data = terminal.onData((bytes) => {
        if (isTerminalQueryReply(bytes)) {
          propsRef.current.onTerminalQueryReply?.(bytes)
        } else {
          propsRef.current.onTerminalInput?.(bytes)
        }
      })
      const parsed = terminal.onWriteParsed(() => notifyModes(terminal, propsRef))
      const resize = new ResizeObserver(() => fit.fit())
      resize.observe(container)

      return () => {
        resize.disconnect()
        parsed.dispose()
        data.dispose()
        rendererRef.current?.dispose()
        rendererRef.current = null
        textZoomRef.current?.dispose()
        textZoomRef.current = null
        linkRef.current?.dispose()
        linkRef.current = null
        selectionRef.current?.dispose()
        selectionRef.current = null
        terminal.dispose()
        terminalRef.current = null
        fitRef.current = null
      }
    }, [])

    useEffect(() => {
      const terminal = terminalRef.current
      if (!terminal) {
        return
      }
      terminal.options.theme = props.terminalTheme?.theme ?? DEFAULT_TERMINAL_THEME
      terminal.options.fontSize = 13 * (props.textScale ?? 1)
      fitRef.current?.fit()
    }, [props.terminalTheme, props.textScale])

    useImperativeHandle(
      ref,
      () => ({
        prepareForForegroundRecovery() {},
        write(data, onParsed) {
          terminalRef.current?.write(data, onParsed)
        },
        init(cols, rows, initialData, preserveScroll, oscLinks, onParsed) {
          const terminal = terminalRef.current
          if (!terminal) {
            onParsed?.()
            return
          }
          const bottomOffset = preserveScroll
            ? terminal.buffer.active.baseY - terminal.buffer.active.viewportY
            : 0
          linkRef.current?.setInitialOscLinks(oscLinks)
          linkRef.current?.setInitialReplayPending(true)
          terminal.reset()
          terminal.resize(cols, rows)
          const finishInit = () => {
            linkRef.current?.setInitialReplayPending(false)
            if (preserveScroll && bottomOffset > 0) {
              terminal.scrollToLine(Math.max(0, terminal.buffer.active.baseY - bottomOffset))
            }
            onParsed?.()
          }
          if (initialData && initialData.length > 0) {
            terminal.write(initialData, finishInit)
          } else {
            finishInit()
          }
        },
        resize(cols, rows) {
          terminalRef.current?.resize(cols, rows)
        },
        reflow(cols, rows) {
          const terminal = terminalRef.current
          if (terminal?.buffer.active.type === 'normal') {
            terminal.resize(cols, rows)
          }
        },
        clear() {
          terminalRef.current?.clear()
        },
        measureFitDimensions() {
          fitRef.current?.fit()
          const terminal = terminalRef.current
          return Promise.resolve(terminal ? { cols: terminal.cols, rows: terminal.rows } : null)
        },
        resetZoom() {
          fitRef.current?.fit()
        },
        cancelSelect() {
          selectionRef.current?.cancelSelect()
        },
        doSelectAll() {
          selectionRef.current?.selectAll()
        },
        awaitReady() {
          return Promise.resolve()
        }
      }),
      []
    )

    const setContainer = useCallback((node: View | null) => {
      containerRef.current = node as unknown as HTMLDivElement | null
    }, [])

    return (
      <View
        ref={setContainer}
        style={[TERMINAL_WEBVIEW_FRAME_STYLES.container, props.style, { overflow: 'hidden' }]}
      />
    )
  }
)

function terminalOptions(
  propsRef: MutableRefObject<TerminalWebViewProps>
): ConstructorParameters<typeof Terminal>[0] {
  const props = propsRef.current
  return {
    allowProposedApi: false,
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    fontSize: 13 * (props.textScale ?? 1),
    linkHandler: {
      activate(_event, uri) {
        activateTerminalWebUri(uri, propsRef.current)
      },
      allowNonHttpProtocols: true
    },
    scrollback: 5_000,
    theme: props.terminalTheme?.theme ?? DEFAULT_TERMINAL_THEME
  }
}

function notifyModes(terminal: Terminal, propsRef: MutableRefObject<TerminalWebViewProps>): void {
  const modes: TerminalModes = {
    bracketedPasteMode: terminal.modes.bracketedPasteMode,
    altScreen: terminal.buffer.active.type === 'alternate',
    mouseTrackingMode: terminal.modes.mouseTrackingMode,
    sgrMouseMode: false,
    sgrMousePixelsMode: false
  }
  propsRef.current.onModesChanged?.(modes)
}
