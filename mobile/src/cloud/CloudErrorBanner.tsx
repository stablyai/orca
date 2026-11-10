import { CircleAlert } from 'lucide-react-native'
import { Pressable, Text, View } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { cloudWorkspaceScreenStyles as styles } from './cloud-workspace-screen-styles'

/** What went wrong, in one line, with the one action that fixes it. */
export function CloudErrorBanner(props: { message: string; onRetry: (() => void) | null }) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.errorBanner} accessibilityRole="alert">
      <CircleAlert size={18} color={colors.statusRed} strokeWidth={2} />
      <Text style={styles.errorText}>{props.message}</Text>
      {props.onRetry ? (
        <Pressable
          accessibilityRole="button"
          onPress={props.onRetry}
          hitSlop={8}
          style={({ pressed }) => [styles.errorRetry, pressed && styles.pressed]}
        >
          <Text style={styles.errorRetryText}>{t('common.tryAgain', 'Try again')}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}
