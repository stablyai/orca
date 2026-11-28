import { useState } from 'react'
import { View } from 'react-native'
import { MobileSegmentedControl } from '../components/controls/MobileSegmentedControl'
import { KeyedBottomDrawer } from '../components/bottom-drawer/keyed-bottom-drawer'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  nativeChatLineSpacingSegments,
  NativeChatTextSizeSlider,
  nativeChatTextSizeLabel,
  StackedRow
} from '../settings/native-chat-text-controls'
import {
  TerminalFontPicker,
  TerminalTextSizeRow,
  terminalFontLabel,
  terminalPointsLabel
} from '../terminal/preferences/settings/TerminalFontSettings'
import {
  terminalFontPxForScale,
  terminalTextScaleForPx
} from '../terminal/preferences/terminal-text-scales'
import { isTerminalPhoneDisplayMode } from '../terminal/session/pane-layout/terminal-phone-display-mode'
import { fitDimensionsFromCell } from '../terminal/viewport/terminal-grid-fit'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  updateNativeChatTextSettings,
  useNativeChatTextSettings
} from './native-chat/preferences/native-chat-text-settings'
import type { MobileSessionController } from './use-mobile-session-controller'

/** Which text the sheet edits: the chat's, or the terminal's. */
export type MobileSessionTextSizeSheetKind = 'chat' | 'terminal'

// Edits the same stored values as Settings, over the live session so the screen behind shows each change.
export function MobileSessionTextSizeSheet({
  controller
}: {
  controller: MobileSessionController
}) {
  const { textSizeSheet, setTextSizeSheet, router } = controller
  const close = () => setTextSizeSheet(null)
  const openSettings = (route: '/native-chat-settings' | '/terminal-settings') => {
    close()
    router.push(route)
  }
  return (
    <KeyedBottomDrawer
      sheet={textSizeSheet}
      sheetKey={(kind) => kind}
      onClose={close}
      // The slider's drag would fight a drag-to-dismiss; the grabber still dismisses.
      contentScrollable={false}
      dimsBackground={false}
    >
      {(kind) =>
        kind === 'chat' ? (
          <ChatTextSheet onDone={close} onMore={() => openSettings('/native-chat-settings')} />
        ) : (
          <TerminalTextSheet
            controller={controller}
            onDone={close}
            onMore={() => openSettings('/terminal-settings')}
          />
        )
      }
    </KeyedBottomDrawer>
  )
}

export function ChatTextSheet({ onDone, onMore }: { onDone: () => void; onMore: () => void }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const settings = useNativeChatTextSettings()
  return (
    <>
      <SheetHeader
        title={t('session.textSizeSheet.chatTitle', 'Chat text')}
        trailing={{ label: t('common.done', 'Done'), onPress: onDone }}
      />
      <ListGroup>
        <StackedRow
          key="size"
          title={t('session.textSizeSheet.size', 'Size')}
          value={nativeChatTextSizeLabel(settings.size, t)}
        >
          {/* Each step saves, so the chat behind follows the drag. */}
          <NativeChatTextSizeSlider
            size={settings.size}
            onValueChange={(size) => void updateNativeChatTextSettings({ size })}
          />
        </StackedRow>
        <View key="spacing" style={styles.segmentRow}>
          <MobileSegmentedControl
            segments={nativeChatLineSpacingSegments(t)}
            selected={settings.lineSpacing}
            onSelect={(lineSpacing) => void updateNativeChatTextSettings({ lineSpacing })}
            fill
          />
        </View>
        <ListRow
          key="more"
          title={t('session.textSizeSheet.moreChat', 'More text settings')}
          navigates
          onPress={onMore}
        />
      </ListGroup>
    </>
  )
}

/** Columns the active pane would fit at `px`, scaled from the cell box measured at its current size. */
function estimatedColumns(controller: MobileSessionController, px: number): number | null {
  const handle = controller.activeHandle
  // A desktop-sized terminal keeps the desktop's columns whatever the phone's text size.
  if (!handle || !isTerminalPhoneDisplayMode(handle, controller.terminalModes)) {
    return null
  }
  const cell = controller.terminalRefs.current.get(handle)?.measuredCellBox()
  const frame = controller.getTerminalPaneViewport(handle).terminalFrameRef.current
  if (!cell || !frame) {
    return null
  }
  const ratio = px / terminalFontPxForScale(cell.fontScale)
  const fit = fitDimensionsFromCell(
    { cellWidth: cell.cellWidth * ratio, cellHeight: cell.cellHeight * ratio },
    frame.width,
    frame.height
  )
  return fit?.cols ?? null
}

function TerminalTextSheet({
  controller,
  onDone,
  onMore
}: {
  controller: MobileSessionController
  onDone: () => void
  onMore: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { terminalTextScale, terminalFontStyle, commitPinchedTextScale, commitTerminalFontStyle } =
    controller
  const [fontPickerOpen, setFontPickerOpen] = useState(false)
  // The label follows a drag; the terminal takes the size once on release, so the PTY resizes once.
  const [draggedPx, setDraggedPx] = useState<number | null>(null)
  const px = draggedPx ?? terminalFontPxForScale(terminalTextScale)
  const columns = estimatedColumns(controller, px)
  const points = terminalPointsLabel(px, t)
  const commit = (next: number) => {
    setDraggedPx(null)
    if (next !== terminalFontPxForScale(terminalTextScale)) {
      commitPinchedTextScale(terminalTextScaleForPx(next))
    }
  }
  return (
    <>
      <SheetHeader
        title={t('session.textSizeSheet.terminalTitle', 'Terminal text')}
        trailing={{ label: t('common.done', 'Done'), onPress: onDone }}
      />
      <ListGroup>
        <TerminalTextSizeRow
          key="size"
          px={px}
          value={
            columns === null
              ? points
              : t('session.textSizeSheet.pointsAndColumns', '{{points}} · {{count}} columns', {
                  points,
                  count: columns
                })
          }
          onPreview={setDraggedPx}
          onCommit={commit}
        />
        <ListRow
          key="font"
          title={t('app.terminalSettings.font', 'Font')}
          value={terminalFontLabel(terminalFontStyle.font, t)}
          navigates
          onPress={() => setFontPickerOpen(true)}
        />
        <ListRow
          key="more"
          title={t('session.textSizeSheet.moreTerminal', 'More terminal settings')}
          navigates
          onPress={onMore}
        />
      </ListGroup>
      <TerminalFontPicker
        visible={fontPickerOpen}
        settings={{ fontStyle: terminalFontStyle, selectFontStyle: commitTerminalFontStyle }}
        onClose={() => setFontPickerOpen(false)}
      />
    </>
  )
}

const styles = themedStyleSheet(() => ({
  segmentRow: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md }
}))
