import { useState } from 'react'
import { useWindowDimensions, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { useRouter } from 'expo-router'
import { spacing } from '../src/theme/mobile-theme'
import { themedStyleSheet } from '../src/theme/themed-styles'
import { useMobileColorScheme } from '../src/theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../src/i18n/use-mobile-translation'
import { ListRow } from '../src/components/list/ListGroup'
import { useTerminalFontSettings } from '../src/terminal/preferences/use-terminal-font-settings'
import {
  TerminalFontPicker,
  TerminalFontSection
} from '../src/terminal/preferences/settings/TerminalFontSettings'
import { TerminalFontPreview } from '../src/terminal/preferences/settings/TerminalFontPreview'
import {
  SettingsScreen,
  SettingsSection,
  settingsScreenStyles
} from '../src/settings/settings-screen-frame'

export default function TerminalFontSettingsScreen() {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const router = useRouter()
  const fontSettings = useTerminalFontSettings()
  const [fontPickerOpen, setFontPickerOpen] = useState(false)
  const window = useWindowDimensions()

  // The slider's gesture needs a root here, as Chat settings has.
  return (
    <GestureHandlerRootView style={settingsScreenStyles.container}>
      <SettingsScreen
        title={t('app.terminalSettings.fontAndSize', 'Font and size')}
        onBack={() => router.back()}
        overlays={
          <TerminalFontPicker
            visible={fontPickerOpen}
            settings={fontSettings}
            onClose={() => setFontPickerOpen(false)}
          />
        }
      >
        <View style={styles.preview}>
          <TerminalFontPreview
            textScale={fontSettings.textScale}
            fontStyle={fontSettings.fontStyle}
            columnsWidth={window.width}
            height={180}
          />
        </View>
        <TerminalFontSection
          settings={fontSettings}
          onOpenFontPicker={() => setFontPickerOpen(true)}
        />
        <SettingsSection>
          <ListRow
            key="reset"
            title={t('app.terminalSettings.resetFont', 'Reset font settings')}
            onPress={fontSettings.reset}
          />
        </SettingsSection>
      </SettingsScreen>
    </GestureHandlerRootView>
  )
}

const styles = themedStyleSheet(() => ({
  preview: { marginBottom: spacing.lg }
}))
