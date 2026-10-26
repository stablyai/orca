import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, Text, View } from 'react-native'
import { CaseSensitive, ChevronRight } from 'lucide-react-native'
import { PickerModal, type PickerOption } from '../components/PickerModal'
import { colors } from '../theme/mobile-theme'
import {
  MAX_TERMINAL_FONT_BYTES,
  TERMINAL_FONT_IMPORT_SUPPORTED,
  clearTerminalFont,
  importTerminalFont,
  loadTerminalFont,
  type TerminalFontPreference
} from '../storage/terminal-font'
import { terminalSettingsScreenStyles as styles } from './terminal-settings-screen-styles'

type FontValue = 'default' | 'custom' | 'import'

type TerminalFontSetting = ReturnType<typeof useTerminalFontSetting>

function fontOptions(font: TerminalFontPreference | null): PickerOption<FontValue>[] {
  return [
    { value: 'default', label: 'System monospace (default)' },
    ...(font ? [{ value: 'custom' as const, label: font.name }] : []),
    {
      value: 'import',
      label: font ? 'Import another font file…' : 'Import font file…',
      subtitle: 'TTF, OTF, WOFF or WOFF2'
    }
  ]
}

export function useTerminalFontSetting() {
  const [font, setFont] = useState<TerminalFontPreference | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  useEffect(() => {
    void loadTerminalFont().then(setFont)
  }, [])
  const select = useCallback(async (value: FontValue) => {
    if (value === 'default') {
      setFont(null)
      await clearTerminalFont()
      return
    }
    if (value !== 'import') {
      return
    }
    try {
      const result = await importTerminalFont()
      if (result.status === 'imported') {
        setFont(result.font)
      } else if (result.status === 'unsupported') {
        Alert.alert('Unsupported file', 'Choose a .ttf, .otf, .woff or .woff2 font file.')
      } else if (result.status === 'too-large') {
        Alert.alert(
          'Font too large',
          `Choose a font file under ${MAX_TERMINAL_FONT_BYTES / 1024 / 1024} MB, or a subset of it.`
        )
      }
    } catch {
      Alert.alert('Import failed', 'The font file could not be copied.')
    }
  }, [])
  return { font, pickerOpen, setPickerOpen, select }
}

export function TerminalFontSection({ setting }: { setting: TerminalFontSetting }) {
  if (!TERMINAL_FONT_IMPORT_SUPPORTED) {
    return null
  }
  return (
    <>
      <Text style={[styles.groupHeading, styles.inputGroupGap]}>FONT</Text>
      <Text style={styles.groupDescription}>
        Use a font file from this device for terminal text, such as a monospace font with Hangul or
        CJK glyphs. Characters the font lacks fall back to the default font. Per-device display
        only; doesn&apos;t change the desktop terminal.
      </Text>
      <View style={[styles.section, styles.sectionTopGap]}>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => setting.setPickerOpen(true)}
        >
          <CaseSensitive size={16} color={colors.textSecondary} />
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>Font</Text>
            <Text style={styles.rowSublabel}>
              {setting.font ? setting.font.name : 'System monospace'}
            </Text>
          </View>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
      </View>
    </>
  )
}

// Rendered at the screen root: inside the ScrollView the drawer's backdrop is clipped.
export function TerminalFontPicker({ setting }: { setting: TerminalFontSetting }) {
  if (!TERMINAL_FONT_IMPORT_SUPPORTED) {
    return null
  }
  return (
    <PickerModal<FontValue>
      visible={setting.pickerOpen}
      title="Terminal font"
      options={fontOptions(setting.font)}
      selected={setting.font ? 'custom' : 'default'}
      onSelect={(value) => void setting.select(value)}
      onClose={() => setting.setPickerOpen(false)}
    />
  )
}
