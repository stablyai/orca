import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native'
import { RotateCw } from 'lucide-react-native'
import { colors } from '../theme/mobile-theme'
import type { PrSidebarState } from '../session/mobile-pr-sidebar-state'
import { prSidebarRenderBranch } from './mobile-pr-sidebar-presentation'
import { mobilePrSidebarStyles as styles } from './pr-sidebar/mobile-pr-sidebar-styles'

type Props = {
  state: PrSidebarState
  onRetry: () => void
  // Applied by the docked column so content clears the home indicator (the screen's
  // SafeAreaView is edges={['top']} only).
  bottomInset?: number
}

// The shell switches on the controller's state machine and renders the section
// placeholders (U5 fills header/reviewers/checks). Style only from mobile-theme.
export function MobilePRSidebar({ state, onRetry, bottomInset = 0 }: Props) {
  const branch = prSidebarRenderBranch(state)
  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomInset }]}
      showsVerticalScrollIndicator={false}
    >
      <PrSidebarContent branch={branch} state={state} onRetry={onRetry} />
    </ScrollView>
  )
}

function PrSidebarContent({
  branch,
  state,
  onRetry
}: {
  branch: ReturnType<typeof prSidebarRenderBranch>
  state: PrSidebarState
  onRetry: () => void
}) {
  if (branch === 'loading') {
    return (
      <View style={styles.stateArea}>
        <ActivityIndicator color={colors.accentBlue} />
        <Text style={styles.stateText}>Loading pull request…</Text>
      </View>
    )
  }
  if (branch === 'error') {
    const message = state.kind === 'error' ? state.message : 'Something went wrong.'
    return (
      <View style={styles.stateArea}>
        <Text style={styles.stateText}>{message}</Text>
        <Pressable
          style={styles.retryButton}
          onPress={onRetry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading pull request"
        >
          <RotateCw size={14} color={colors.textPrimary} strokeWidth={2.2} />
          <Text style={styles.retryText}>Retry</Text>
        </Pressable>
      </View>
    )
  }
  if (branch === 'blocked') {
    // Permanent failure (R9): explanatory, no retry-encouragement styling.
    const message =
      state.kind === 'blocked'
        ? state.message
        : 'Not permitted — your GitHub account is not connected.'
    return (
      <View style={styles.stateArea}>
        <Text style={styles.blockedText}>{message}</Text>
      </View>
    )
  }
  if (branch === 'ready') {
    return <PrSidebarSections />
  }
  return null
}

// Placeholder section areas; U5 replaces these with the real header/reviewers/checks.
function PrSidebarSections() {
  return (
    <>
      <PlaceholderSection label="PR header" />
      <PlaceholderSection label="Reviewers" />
      <PlaceholderSection label="Checks" />
    </>
  )
}

function PlaceholderSection({ label }: { label: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      <Text style={styles.placeholderText}>Coming soon</Text>
    </View>
  )
}
