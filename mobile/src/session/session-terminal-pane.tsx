import { computeActiveTerminalKeyboardLift } from '../terminal/keyboard/terminal-keyboard-avoidance-lift'
import { terminalPaneKeyboardLayout } from '../terminal/session/pane-layout/mobile-terminal-pane-layout'
import { TerminalPaneView } from '../terminal/session/pane-layout/TerminalPaneView'
import type { TerminalFrame } from '../terminal/webview/terminal-webview-messages'
import type { MobileSessionController } from './use-mobile-session-controller'

type PaneTerminal = {
  handle: string
  title?: string
  terminalTheme?: React.ComponentProps<typeof TerminalPaneView>['terminalTheme']
}

/** One mounted terminal pane, including the split-pane keyboard lift. */
export function SessionTerminalPane({
  terminal,
  controller,
  activeHandle,
  terminalSplitActive,
  visibleTerminalHandles,
  paneFrame,
  paneDirection,
  keyboardLift,
  activeTerminalKeyboardLift,
  onOpenUrl
}: {
  terminal: PaneTerminal
  controller: MobileSessionController
  activeHandle: string | null
  terminalSplitActive: boolean
  visibleTerminalHandles: readonly string[]
  paneFrame: TerminalFrame
  paneDirection: 'row' | 'column'
  keyboardLift: number
  activeTerminalKeyboardLift: number
  onOpenUrl: (handle: string, url: string) => void
}): React.JSX.Element {
  const visible = visibleTerminalHandles.includes(terminal.handle)
  const split = terminalSplitActive && visible
  const lift =
    terminal.handle !== activeHandle && !split
      ? 0
      : split
        ? computeActiveTerminalKeyboardLift({
            keyboardLift: terminalPaneKeyboardLayout(
              paneFrame,
              paneDirection,
              visibleTerminalHandles.indexOf(terminal.handle),
              keyboardLift
            ).occlusion,
            metrics: controller.terminalKeyboardMetrics.get(terminal.handle),
            terminalFrameHeight:
              controller.getTerminalPaneViewport(terminal.handle).terminalFrameRef.current
                ?.height ?? 0
          })
        : activeTerminalKeyboardLift
  return (
    <TerminalPaneView
      handle={terminal.handle}
      active={terminal.handle === activeHandle}
      visible={visible}
      splitIndex={split ? visibleTerminalHandles.indexOf(terminal.handle) : undefined}
      splitDirection={paneDirection}
      splitFrame={paneFrame}
      keyboardInset={keyboardLift}
      title={terminal.title}
      onFrame={controller.notifyTerminalPaneFrame}
      keyboardLift={lift}
      terminalTheme={terminal.terminalTheme}
      hostSettings={controller.terminalHostSettings}
      textScale={controller.terminalTextScale}
      fontStyle={controller.terminalFontStyle}
      onTextScaleChange={controller.commitPinchedTextScale}
      onRef={controller.setTerminalWebViewRef}
      onDocumentReleased={controller.releaseTerminalDocument}
      onWebReady={controller.handleTerminalWebReady}
      onCellBoxChange={controller.notifyTerminalCellBoxChange}
      onSelectionMode={controller.handleSelectionMode}
      onSelectionCopy={controller.handleSelectionCopy}
      onSelectionEvicted={controller.handleSelectionEvicted}
      onClipboardWrite={controller.handleClipboardWrite}
      onModesChanged={controller.handleModesChanged}
      onKeyboardAvoidanceMetrics={controller.handleKeyboardAvoidanceMetrics}
      onHaptic={controller.handleHaptic}
      onTerminalInput={controller.handleTerminalInput}
      onTerminalQueryReply={controller.handleTerminalQueryReply}
      onTerminalInteraction={controller.handleTerminalInteraction}
      onTerminalTap={controller.handleTerminalTap}
      onFileTap={controller.handleFileTap}
      onOpenUrl={onOpenUrl}
    />
  )
}
