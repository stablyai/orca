import { View, Text, Pressable, Switch, Platform } from 'react-native'
import { ChevronRight, X } from 'lucide-react-native'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import { CustomKeyModal } from './CustomKeyModal'
import { useTerminalShortcutSettings } from './use-terminal-shortcut-settings'
import { DragReorderList } from './DragReorderList'
import { colors } from '../theme/mobile-theme'
import { terminalShortcutSettingsStyles as styles } from './terminal-shortcut-settings-styles'
import {
  nativeTerminalSettingsOperations,
  type TerminalShortcutPreferences
} from '../terminal/terminal-settings-operations'
import type { TerminalAccessoryKey } from '../terminal/terminal-accessory-keys'

// Why: DragReorderList absolutely positions rows, so every row in a
// reorderable section must share one fixed height.
const REORDER_ROW_HEIGHT = 56

function ShortcutBarRow({
  shortcutKey,
  visible,
  onToggle,
  disabled
}: {
  shortcutKey: TerminalAccessoryKey
  visible: boolean
  onToggle: (visible: boolean) => void
  disabled: boolean
}): React.JSX.Element {
  return (
    <View style={styles.reorderRowContent}>
      <View style={styles.keycap}>
        <Text style={styles.keycapText}>{shortcutKey.label}</Text>
      </View>
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{shortcutKey.accessibilityLabel ?? shortcutKey.label}</Text>
      </View>
      <Switch
        disabled={disabled}
        accessibilityLabel={shortcutKey.accessibilityLabel ?? shortcutKey.label}
        accessibilityState={{ disabled }}
        value={visible}
        onValueChange={onToggle}
        trackColor={{ false: colors.borderSubtle, true: colors.textSecondary }}
        thumbColor={colors.textPrimary}
        {...(Platform.OS === 'web' ? { activeThumbColor: colors.textPrimary } : {})}
      />
    </View>
  )
}

type Props = {
  scrollRef: AnimatedRef<Animated.ScrollView>
  scrollOffsetY: SharedValue<number>
  scrollContentHeight: SharedValue<number>
  onDragActiveChange: (active: boolean) => void
  preferences?: TerminalShortcutPreferences
}

export function TerminalShortcutSettings({
  scrollRef,
  scrollOffsetY,
  scrollContentHeight,
  onDragActiveChange,
  preferences = nativeTerminalSettingsOperations
}: Props): React.JSX.Element {
  const {
    busy,
    error,
    customKeys,
    showCustomKeyModal,
    setShowCustomKeyModal,
    visibleBuiltInSet,
    orderedAccessoryKeys,
    handleDeleteCustomKey,
    toggleBuiltInKey,
    reorderBuiltInKeys,
    resetBuiltInKeys,
    reorderCustomKeys,
    customKeysWriteSeqRef,
    setCustomKeys
  } = useTerminalShortcutSettings(preferences)

  return (
    <>
      {error && (
        <Text accessibilityRole="alert" style={styles.groupDescription}>
          {error}
        </Text>
      )}
      <View pointerEvents={busy ? 'none' : 'auto'} accessibilityState={{ busy, disabled: busy }}>
        <Text style={[styles.groupHeading, styles.groupTopGap]}>SHORTCUT BAR</Text>
        <Text style={styles.groupDescription}>
          Toggle keys to show or hide them, and hold the grip to drag a key into the order you want
          on the terminal shortcut bar.
        </Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          <DragReorderList
            items={orderedAccessoryKeys}
            itemKey={(shortcutKey) => shortcutKey.id}
            rowHeight={REORDER_ROW_HEIGHT}
            scrollRef={scrollRef}
            scrollOffsetY={scrollOffsetY}
            scrollContentHeight={scrollContentHeight}
            onDragActiveChange={onDragActiveChange}
            onReorder={reorderBuiltInKeys}
            renderRow={(shortcutKey) => (
              <ShortcutBarRow
                shortcutKey={shortcutKey}
                disabled={busy}
                visible={visibleBuiltInSet.has(shortcutKey.id)}
                onToggle={(visible) => toggleBuiltInKey(shortcutKey.id, visible)}
              />
            )}
          />
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            disabled={busy}
            onPress={resetBuiltInKeys}
          >
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Reset Defaults</Text>
              <Text style={styles.rowSublabel}>
                Show every built-in shortcut key in the original order
              </Text>
            </View>
          </Pressable>
        </View>

        <Text style={[styles.groupHeading, styles.groupTopGap]}>CUSTOM SHORTCUTS</Text>
        <View style={[styles.section, styles.sectionTopGap]}>
          {customKeys.length === 0 ? (
            <>
              <View style={styles.emptyContainer}>
                <Text style={styles.emptyText}>No custom shortcuts defined yet.</Text>
              </View>
              <View style={styles.separator} />
            </>
          ) : (
            <DragReorderList
              items={customKeys}
              itemKey={(key) => key.id}
              rowHeight={REORDER_ROW_HEIGHT}
              scrollRef={scrollRef}
              scrollOffsetY={scrollOffsetY}
              scrollContentHeight={scrollContentHeight}
              onDragActiveChange={onDragActiveChange}
              onReorder={reorderCustomKeys}
              renderRow={(key) => (
                <View style={styles.reorderRowContent}>
                  <View style={styles.keycap}>
                    <Text style={styles.keycapText}>{key.label}</Text>
                  </View>
                  <View style={styles.rowContent}>
                    <Text style={styles.rowLabel}>{key.label}</Text>
                    <Text style={styles.rowSublabel} numberOfLines={1} ellipsizeMode="tail">
                      {key.bytes.replace(/\r/g, ' ↵')}
                    </Text>
                  </View>
                  <Pressable
                    style={({ pressed }) => [
                      styles.deleteButton,
                      pressed && styles.deleteButtonPressed
                    ]}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${key.label}`}
                    onPress={() => handleDeleteCustomKey(key)}
                  >
                    <X size={16} color={colors.statusRed} />
                  </Pressable>
                </View>
              )}
            />
          )}
          <Pressable
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Add custom shortcut"
            onPress={() => setShowCustomKeyModal(true)}
          >
            <View style={styles.rowContent}>
              <Text style={styles.rowLabel}>Add Custom Shortcut…</Text>
              <Text style={styles.rowSublabel}>Create key combo or text macro</Text>
            </View>
            <ChevronRight size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      </View>
      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
        loadKeys={preferences.loadKeys}
        saveKeys={preferences.saveKeys}
        onKeysChanged={(keys) => {
          // Why: the modal already persisted this list; bumping the sequence
          // discards refreshes that read storage before its save landed.
          customKeysWriteSeqRef.current += 1
          setCustomKeys(keys)
        }}
      />
    </>
  )
}
