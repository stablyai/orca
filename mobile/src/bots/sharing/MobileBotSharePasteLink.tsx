// From a link's first page: the link field, with Paste reading the clipboard on a tap (iOS asks on
// every read, so it never reads on its own). Continue waits until the text reads as a bot link.
import { Text } from 'react-native'
import { parseBotShareId } from '../../../../src/shared/skills/sharing/skill-share-link'
import { TextField } from '../../components/composer-input/TextField'
import { SheetHeader } from '../../components/nav-bar/SheetHeader'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { useClipboardReader } from '../../platform/clipboard/clipboard'
import { spacing } from '../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../theme/themed-styles'
import { MobileBotTextButton } from '../MobileBotTextButton'

export function MobileBotSharePasteLink(props: {
  /** The chosen computer answers; until it does, Continue waits. */
  reachable: boolean
  value: string
  setValue: (value: string) => void
  error: string | null
  onBack: () => void
  onLink: (shareId: string) => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const clipboard = useClipboardReader()
  const { value, setValue } = props
  const shareId = props.reachable ? parseBotShareId(value) : null
  return (
    <>
      <SheetHeader
        title={t('bots.share.receive.fromLink', 'From a link')}
        onBack={{ label: t('bots.new.title', 'New bot'), onPress: props.onBack }}
        trailing={{
          label: t('bots.share.receive.continue', 'Continue'),
          disabled: !shareId,
          onPress: () => shareId && props.onLink(shareId)
        }}
      />
      <Text style={styles.description}>
        {t('bots.share.receive.pasteDescription', 'Paste a link someone shared.')}
      </Text>
      <TextField
        value={value}
        onChangeText={setValue}
        placeholder={t('bots.share.receive.linkPlaceholder', 'https://app.orca.dev/bots/share/…')}
        accessibilityLabel={t('bots.share.receive.link', 'Link')}
        monospace
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        returnKeyType="go"
        onSubmitEditing={() => shareId && props.onLink(shareId)}
        trailing={
          value ? undefined : (
            <MobileBotTextButton
              label={t('bots.share.receive.paste', 'Paste')}
              onPress={() =>
                void clipboard.readText().then(
                  (text) => setValue(text.trim()),
                  () => undefined
                )
              }
            />
          )
        }
      />
      {props.error ? <Text style={styles.error}>{props.error}</Text> : null}
    </>
  )
}

const stylesSheet = themedStyleSheet((colors) => ({
  description: { fontSize: 14, color: colors.textSecondary, marginBottom: spacing.sm },
  error: { fontSize: 13, color: colors.statusRed, marginTop: spacing.sm }
}))
