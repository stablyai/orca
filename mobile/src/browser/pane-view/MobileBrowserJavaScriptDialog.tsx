import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { spacing } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { FieldTextInput } from '../../components/composer-input/FieldTextInput'
import type { BrowserDialogState } from '../screencast/mobile-browser-stream-events'
import { mobileBrowserPaneStyles as styles } from './mobile-browser-pane-styles'

type DialogMethod = 'browser.dialogDismiss' | 'browser.dialogAccept'

/** The page's alert, confirm or prompt, worded as desktop's card; a prompt's answer starts at the page's default. */
export function MobileBrowserJavaScriptDialog({
  dialog,
  keyboardLift,
  sendDialogCommand
}: {
  dialog: BrowserDialogState
  keyboardLift: number
  sendDialogCommand: (method: DialogMethod, promptText?: string) => Promise<void>
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  // Null until typed: an untouched answer is left to the host, which knows the default even when it doesn't send one.
  const [typedText, setTypedText] = useState<string | null>(null)
  const isPrompt = dialog.dialogType === 'prompt'
  const pending = dialog.pending !== undefined
  const accept = () =>
    void sendDialogCommand('browser.dialogAccept', isPrompt ? (typedText ?? undefined) : undefined)
  return (
    // The page viewport stays put under the keyboard, so center the card in what the keyboard leaves visible.
    <View style={[styles.dialogOverlay, { paddingBottom: spacing.xl + keyboardLift }]}>
      <View style={styles.dialogCard}>
        <Text style={styles.dialogTitle}>
          {dialog.origin
            ? t('browser.paneView.dialogTitleWithOrigin', '{{origin}} says', {
                origin: dialog.origin
              })
            : t('browser.paneView.dialogTitleNoOrigin', 'This page says')}
        </Text>
        <Text style={styles.dialogMessage}>{dialog.message}</Text>
        {isPrompt ? (
          <FieldTextInput
            style={styles.dialogInput}
            value={typedText ?? dialog.defaultPromptText}
            onChangeText={setTypedText}
            accessibilityLabel={t('browser.paneView.dialogAnswer', 'Answer')}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            editable={!pending}
            onSubmitEditing={accept}
          />
        ) : null}
        {/* The page is still blocked, so the buttons stay live and the card says why. */}
        {dialog.error ? <Text style={styles.dialogError}>{dialog.error}</Text> : null}
        <View style={styles.dialogActions}>
          {dialog.dialogType !== 'alert' ? (
            <Pressable
              disabled={pending}
              style={({ pressed }) => [
                styles.dialogButton,
                pressed && styles.dialogButtonPressed,
                pending && styles.dialogButtonDisabled
              ]}
              onPress={() => void sendDialogCommand('browser.dialogDismiss')}
            >
              <Text style={styles.dialogButtonText}>{t('common.cancel', 'Cancel')}</Text>
            </Pressable>
          ) : null}
          <Pressable
            disabled={pending}
            style={({ pressed }) => [
              styles.dialogButton,
              styles.dialogButtonPrimary,
              pressed && styles.dialogButtonPressed,
              pending && styles.dialogButtonDisabled
            ]}
            onPress={accept}
          >
            <Text style={[styles.dialogButtonText, styles.dialogButtonPrimaryText]}>
              {t('common.ok', 'OK')}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}
