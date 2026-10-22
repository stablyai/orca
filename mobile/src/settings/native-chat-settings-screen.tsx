import { useEffect, useState } from 'react'
import { View, Text, StyleSheet, Pressable, ScrollView, Switch } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft, Minus, Plus } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import {
  getRecentSessionCardsMaxDisplaySync,
  hydrateRecentSessionCards,
  MAX_RECENT_SESSION_CARDS_LIMIT,
  MIN_RECENT_SESSION_CARDS_DISPLAY,
  setRecentSessionCardsMaxDisplay,
  subscribeRecentSessionCards
} from '../session/recent-session-cards'
import { useMobileDefaultSessionViewPreference } from '../session/use-mobile-default-session-view-preference'

export default function NativeChatSettingsScreen({ onBack }: { onBack?: () => void }) {
  const router = useRouter()
  const insets = useSafeAreaInsets()

  const { defaultView, setDefaultView } = useMobileDefaultSessionViewPreference()
  const chatDefault = defaultView === 'chat'
  const [recentMaxDisplay, setRecentMaxDisplay] = useState(() =>
    getRecentSessionCardsMaxDisplaySync()
  )
  useEffect(() => {
    void hydrateRecentSessionCards().catch(() => {})
    return subscribeRecentSessionCards(() =>
      setRecentMaxDisplay(getRecentSessionCardsMaxDisplaySync())
    )
  }, [])
  const canDecreaseRecent = recentMaxDisplay > MIN_RECENT_SESSION_CARDS_DISPLAY
  const canIncreaseRecent = recentMaxDisplay < MAX_RECENT_SESSION_CARDS_LIMIT

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={styles.backButton}
          onPress={onBack ?? (() => router.back())}
        >
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Chat UI</Text>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingBottom: insets.bottom + spacing.lg }}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.groupHeading}>DEFAULT VIEW</Text>
        <Text style={styles.groupDescription}>
          Choose how supported agent sessions (Claude, Codex, and other chat-capable agents) open on
          this device. Terminal shows the raw CLI; Chat UI shows a chat interface like the desktop
          app. You can still switch any individual session from its long-press menu.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Open sessions in Chat UI</Text>
              <Text style={styles.rowSublabel}>{chatDefault ? 'On' : 'Off'}</Text>
            </View>
            <Switch
              accessibilityLabel="Open sessions in Chat UI"
              value={chatDefault}
              onValueChange={(next) => setDefaultView(next ? 'chat' : 'terminal')}
              trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
            />
          </View>
        </View>

        <Text style={[styles.groupHeading, styles.groupTopGap]}>RECENTLY USED</Text>
        <Text style={styles.groupDescription}>
          Customize how many recently visited cards appear in the session menu (default 7).
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <View style={styles.row}>
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Max recent items</Text>
              <Text style={styles.rowSublabel}>{recentMaxDisplay} cards</Text>
            </View>
            <View style={styles.stepper}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Decrease max recent items"
                disabled={!canDecreaseRecent}
                onPress={() => setRecentSessionCardsMaxDisplay(recentMaxDisplay - 1)}
                style={({ pressed }) => [
                  styles.stepperButton,
                  !canDecreaseRecent && styles.stepperButtonDisabled,
                  pressed && canDecreaseRecent && styles.stepperButtonPressed
                ]}
              >
                <Minus size={16} color={colors.textPrimary} />
              </Pressable>
              <Text style={styles.stepperValue}>{recentMaxDisplay}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Increase max recent items"
                disabled={!canIncreaseRecent}
                onPress={() => setRecentSessionCardsMaxDisplay(recentMaxDisplay + 1)}
                style={({ pressed }) => [
                  styles.stepperButton,
                  !canIncreaseRecent && styles.stepperButtonDisabled,
                  pressed && canIncreaseRecent && styles.stepperButtonPressed
                ]}
              >
                <Plus size={16} color={colors.textPrimary} />
              </Pressable>
            </View>
          </View>
        </View>
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bgBase,
    paddingHorizontal: spacing.lg
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.lg
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: {
    fontSize: 20,
    fontWeight: '700',
    color: colors.textPrimary
  },
  groupHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  groupDescription: {
    fontSize: typography.bodySize - 1,
    color: colors.textSecondary,
    lineHeight: 20,
    paddingHorizontal: spacing.xs
  },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    overflow: 'hidden'
  },
  sectionTopGap: {
    marginTop: spacing.sm
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md + 2
  },
  rowContent: {
    flex: 1
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary
  },
  rowSublabel: {
    fontSize: typography.bodySize - 2,
    color: colors.textSecondary,
    marginTop: 2
  },
  groupTopGap: {
    marginTop: spacing.xl
  },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.bgRaised,
    borderRadius: 8,
    padding: 4
  },
  stepperButton: {
    width: 28,
    height: 28,
    borderRadius: 6,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepperButtonPressed: {
    backgroundColor: colors.bgPanel
  },
  stepperButtonDisabled: {
    opacity: 0.35
  },
  stepperValue: {
    minWidth: 24,
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary,
    textAlign: 'center'
  }
})
