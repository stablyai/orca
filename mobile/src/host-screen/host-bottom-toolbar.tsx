import { Keyboard, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { Plus, SlidersHorizontal, X } from 'lucide-react-native'
import { MobileSearchField } from '../components/MobileSearchField'
import { IconButton } from '../components/ui/IconButton'
import { useKeyboardOcclusion } from '../platform/keyboard-occlusion'
import { colors, spacing } from '../theme/mobile-theme'
import { workspaceOptionsAccessibilityLabel } from '../worktree/workspace-options-copy'
import { WorkspaceOptionsCountBadge } from './workspace-options-count-badge'
import type { HostScreenController } from './use-host-screen-controller'

const FADE_ID = 'host-bottom-toolbar-fade'

/**
 * The phone list's one toolbar, under the thumb: filter, search and New workspace. While search is
 * active it rides on the keyboard and New workspace gives way to a close button that clears the query.
 */
export function HostBottomToolbar({
  controller,
  bottomInset,
  searchActive,
  onSearchActiveChange,
  onLayout
}: {
  controller: HostScreenController
  bottomInset: number
  searchActive: boolean
  onSearchActiveChange: (active: boolean) => void
  onLayout: (event: LayoutChangeEvent) => void
}) {
  const { actions, connState, state } = controller
  const keyboardHeight = useKeyboardOcclusion()
  const keyboardUp = keyboardHeight > 0

  const closeSearch = () => {
    state.setSearch('')
    onSearchActiveChange(false)
    Keyboard.dismiss()
  }

  return (
    <View
      style={[
        styles.bar,
        keyboardUp
          ? { bottom: keyboardHeight, paddingBottom: spacing.sm }
          : { paddingBottom: Math.max(bottomInset, spacing.lg) }
      ]}
      onLayout={onLayout}
    >
      <View pointerEvents="none" style={styles.fade}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id={FADE_ID} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.bgBase} stopOpacity={0} />
              <Stop offset="0.55" stopColor={colors.bgBase} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${FADE_ID})`} />
        </Svg>
      </View>
      <View style={styles.row}>
        {searchActive ? null : (
          <View>
            <IconButton
              icon={SlidersHorizontal}
              variant="floating"
              iconSize={18}
              accessibilityLabel={workspaceOptionsAccessibilityLabel(controller.activeFilterCount)}
              selected={controller.activeFilterCount > 0}
              onPress={() => state.setShowWorkspaceOptions(true)}
            />
            <WorkspaceOptionsCountBadge count={controller.activeFilterCount} />
          </View>
        )}
        <View style={styles.search}>
          <MobileSearchField
            value={state.search}
            onChangeText={state.setSearch}
            onFocus={() => onSearchActiveChange(true)}
            onBlur={() => {
              if (state.search.trim() === '') {
                onSearchActiveChange(false)
              }
            }}
            floating
            placeholder="Search workspaces"
            accessibilityLabel="Search workspaces"
          />
        </View>
        {searchActive ? (
          <IconButton
            icon={X}
            variant="floating"
            iconSize={18}
            accessibilityLabel="Close search"
            onPress={closeSearch}
          />
        ) : (
          <IconButton
            icon={Plus}
            variant="primary"
            accessibilityLabel="New workspace"
            onPress={actions.openNewWorktreeModal}
            disabled={connState !== 'connected'}
          />
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 44,
    paddingHorizontal: spacing.md
  },
  fade: { ...StyleSheet.absoluteFillObject },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  search: { flex: 1, minWidth: 0 }
})
