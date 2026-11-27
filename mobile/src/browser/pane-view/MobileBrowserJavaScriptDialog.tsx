import { useState } from 'react'
import { Text } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { BottomDrawer } from '../../components/bottom-drawer/BottomDrawer'
import { ConfirmModal } from '../../components/sheets/ConfirmModal'
import { TextInputSheetContent } from '../../components/sheets/TextInputModal'
import type { BrowserDialogState } from '../screencast/mobile-browser-stream-events'
import { useLastShownData } from '../../query/use-last-shown-data'
import { mobileBrowserSiteName } from './mobile-browser-page-prompt-copy'
import { mobileBrowserPaneStyles as styles } from './mobile-browser-pane-styles'

type DialogMethod = 'browser.dialogDismiss' | 'browser.dialogAccept'

/**
 * The page's alert, confirm or prompt as the app's confirm sheet, titled "<site> says". It stays
 * open until the host says the page let go, so a failed answer keeps it up with the reason.
 */
export function MobileBrowserJavaScriptDialog({
  dialog,
  sendDialogCommand
}: {
  dialog: BrowserDialogState | null
  sendDialogCommand: (method: DialogMethod, promptText?: string) => Promise<void>
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  // Kept through the sheet's close, after the host has let the page go.
  const shown = useLastShownData(dialog ?? undefined, null)
  if (!shown) {
    return null
  }
  const visible = dialog !== null
  const pending = shown.pending !== undefined
  const title = shown.origin
    ? t('browser.paneView.dialogTitleWithOrigin', '{{origin}} says', {
        origin: mobileBrowserSiteName(shown.origin)
      })
    : t('browser.paneView.dialogTitleNoOrigin', 'This page says')
  // Only the host's close event closes the sheet, so the page is never left blocked behind nothing.
  const dismiss = () => {
    if (visible && !pending) {
      void sendDialogCommand('browser.dialogDismiss')
    }
  }
  const accept = (promptText?: string) => {
    if (visible && !pending) {
      void sendDialogCommand('browser.dialogAccept', promptText)
    }
  }
  if (shown.dialogType === 'prompt') {
    return (
      <BottomDrawer visible={visible} onClose={dismiss} dismissible={false}>
        <JavaScriptPromptContent
          key={shown.occurrence}
          title={title}
          dialog={shown}
          onAccept={accept}
          onCancel={dismiss}
        />
      </BottomDrawer>
    )
  }
  return (
    <ConfirmModal
      visible={visible}
      dismissible={false}
      title={title}
      message={shown.message}
      details={shown.error ? <Text style={styles.dialogError}>{shown.error}</Text> : null}
      confirmLabel={t('common.ok', 'OK')}
      cancelLabel={shown.dialogType === 'alert' ? null : undefined}
      onConfirm={() => accept()}
      onCancelPress={dismiss}
      onCancel={() => {}}
    />
  )
}

function JavaScriptPromptContent({
  title,
  dialog,
  onAccept,
  onCancel
}: {
  title: string
  dialog: BrowserDialogState
  onAccept: (promptText?: string) => void
  onCancel: () => void
}) {
  const t = useMobileTranslation()
  // Null until typed: an untouched answer is left to the host, which knows the default even when it doesn't send one.
  const [typedText, setTypedText] = useState<string | null>(null)
  return (
    <TextInputSheetContent
      title={title}
      message={dialog.message}
      value={typedText ?? dialog.defaultPromptText}
      onChangeText={setTypedText}
      submitLabel={t('common.ok', 'OK')}
      allowEmpty
      selectTextOnFocus
      error={dialog.error}
      busy={dialog.pending !== undefined}
      onSubmit={() => onAccept(typedText ?? undefined)}
      onCancel={onCancel}
    />
  )
}
