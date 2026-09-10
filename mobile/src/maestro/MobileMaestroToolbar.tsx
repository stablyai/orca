import { Pressable, Text, View } from 'react-native'
import { ChevronLeft, Maximize2, Plus, RefreshCw } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import { mobileMaestroScreenStyles as styles } from './mobile-maestro-screen-styles'

type MobileMaestroToolbarProps = {
  title: string
  mutationBusy: boolean
  onBack: () => void
  onAdd: () => void
  onFit: () => void
  onRefresh: () => void
}

export function MobileMaestroToolbar({
  title,
  mutationBusy,
  onBack,
  onAdd,
  onFit,
  onRefresh
}: MobileMaestroToolbarProps) {
  return (
    <View style={styles.toolbar}>
      <Pressable accessibilityLabel="Back" onPress={onBack} style={styles.iconButton}>
        <ChevronLeft size={20} color={colors.textPrimary} />
      </Pressable>
      <View style={styles.heading}>
        <Text style={styles.title}>Maestro</Text>
        <Text style={styles.subtitle} numberOfLines={1}>
          {title}
        </Text>
      </View>
      <Pressable
        accessibilityLabel="Add to Canvas"
        disabled={mutationBusy}
        onPress={onAdd}
        style={styles.iconButton}
      >
        <Plus size={20} color={colors.textPrimary} />
      </Pressable>
      <Pressable
        accessibilityLabel="Fit Canvas"
        disabled={mutationBusy}
        onPress={onFit}
        style={styles.iconButton}
      >
        <Maximize2 size={17} color={colors.textSecondary} />
      </Pressable>
      <Pressable accessibilityLabel="Refresh Canvas" onPress={onRefresh} style={styles.iconButton}>
        <RefreshCw size={17} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}
