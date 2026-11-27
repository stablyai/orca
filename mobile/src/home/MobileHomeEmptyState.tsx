import { Clipboard, Laptop, ScanQrCode } from 'lucide-react-native'
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { SheetSecondaryButton } from '../components/sheets/SheetSecondaryButton'
import { TextInputModal } from '../components/sheets/TextInputModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { MobileHomeAppMoveBanner } from './MobileHomeAppMoveBanner'
import { MobileHomeTabEmpty } from './tabs/MobileHomeTabEmpty'

/** Feed with nothing paired: what to open on the computer, then Scan code or Paste code above the tabs. */
export function MobileHomeEmptyState(props: {
  contentMaxWidth: number
  isWideLayout: boolean
  onScanCode: () => void
  onPasteCode: (code: string) => void
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const [pasting, setPasting] = useState(false)
  const wide = props.isWideLayout && {
    maxWidth: props.contentMaxWidth,
    width: '100%' as const,
    alignSelf: 'center' as const
  }
  return (
    <>
      {/* Scrolls because a phone in landscape is shorter than the message and the buttons together. */}
      <ScrollView contentContainerStyle={[styles.content, wide]}>
        <MobileHomeAppMoveBanner />
        <MobileHomeTabEmpty
          centred
          icon={Laptop}
          title={t('home.emptyState.connectComputer', 'Connect your computer')}
          message={t(
            'home.emptyState.openSettingsMobile',
            'Open Orca on your computer, then Settings → Mobile.'
          )}
        />
      </ScrollView>
      <View style={[styles.foot, wide]}>
        <SheetPrimaryButton
          icon={ScanQrCode}
          label={t('app.pairScan.scanCode', 'Scan code')}
          onPress={props.onScanCode}
        />
        <SheetSecondaryButton
          icon={Clipboard}
          label={t('app.pairScan.pasteCode', 'Paste code')}
          onPress={() => setPasting(true)}
        />
      </View>
      <TextInputModal
        visible={pasting}
        title={t('app.pairScan.pasteCodeTitle', 'Paste pairing code')}
        message={t(
          'app.pairScan.pasteCodeMessage',
          'Copy the code shown under the QR on your computer.'
        )}
        placeholder={t(
          'app.pairScan.pasteCodePlaceholder',
          'orca://pair?code=... or paste the code'
        )}
        onSubmit={(code) => {
          setPasting(false)
          props.onPasteCode(code)
        }}
        onCancel={() => setPasting(false)}
      />
    </>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  content: { flexGrow: 1, paddingHorizontal: spacing.lg },
  foot: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg }
}))
