import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { Plus } from 'lucide-react-native'
import { voiceSettingsStyles as styles } from '../settings/voice-settings-styles'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { voiceNativeModule, type TileAddResult } from './voice-native-module'

const MANUAL = 'Pull down Quick Settings, tap the pencil and drag in Read aloud'

const RESULT_TEXT: Record<TileAddResult, string> = {
  added: 'Added — pull down from the top of the screen to find Read aloud',
  'already-added': 'Already in Quick Settings',
  'not-added': `Not added. ${MANUAL}`,
  unsupported: MANUAL,
  error: MANUAL
}

// Why: only Android 13+ can prompt to add a tile; older versions get the manual steps.
export function QuickSettingsTileRow(): React.JSX.Element | null {
  useMobileColorScheme()
  const native = voiceNativeModule()
  const [result, setResult] = useState<TileAddResult | null>(null)
  if (native === null) {
    return null
  }
  return (
    <>
      <View style={styles.separator} />
      <Pressable
        accessibilityRole="button"
        style={styles.row}
        onPress={() => {
          void native.requestAddTile().then(setResult, () => setResult('error'))
        }}
      >
        <View style={styles.rowContent}>
          <Text style={styles.rowLabel}>Add the Quick Settings tile</Text>
          <Text style={styles.rowSublabel}>
            {result
              ? RESULT_TEXT[result]
              : 'Pause and resume auto-read from the panel you pull down from the top, like the flashlight'}
          </Text>
        </View>
        <Plus size={18} color={colors.textSecondary} />
      </Pressable>
    </>
  )
}
