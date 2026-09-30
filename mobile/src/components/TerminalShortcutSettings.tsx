import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AppState,
  View,
  Text,
  StyleSheet,
  Pressable,
  Switch,
  type AppStateStatus
} from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ChevronRight, X } from 'lucide-react-native'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import { CustomKeyModal, loadCustomKeys, saveCustomKeys, type CustomKey } from './CustomKeyModal'
import { DragReorderList } from './DragReorderList'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { TerminalAccessoryKey } from '../terminal/terminal-accessory-keys'
import {
  getDefaultTerminalAccessoryLayout,
  loadTerminalAccessoryLayout,
  getTerminalAccessoryEntries,
  reorderTerminalAccessoryIds,
  resetTerminalAccessoryLayout,
  saveTerminalAccessoryLayout,
  setTerminalAccessoryBuiltInVisible,
  type TerminalAccessoryLayout
} from '../terminal/terminal-accessory-layout'

// Why: DragReorderList absolutely positions rows, so every row in a
// reorderable section must share one fixed height.
const REORDER_ROW_HEIGHT = 56

function ShortcutBarRow({
  shortcutKey,
  visible,
  onToggle
}: {
  shortcutKey: TerminalAccessoryKey
  visible: boolean
  onToggle: (visible: boolean) => void
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
        value={visible}
        onValueChange={onToggle}
        trackColor={{ false: colors.borderSubtle, true: colors.textSecondary }}
        thumbColor={colors.textPrimary}
      />
    </View>
  )
}

type Props = {
  scrollRef: AnimatedRef<Animated.ScrollView>
  scrollOffsetY: SharedValue<number>
  scrollContentHeight: SharedValue<number>
  onDragActiveChange: (active: boolean) => void
}

export function TerminalShortcutSettings({
  scrollRef,
  scrollOffsetY,
  scrollContentHeight,
  onDragActiveChange
}: Props): React.JSX.Element {
  const [customKeys, setCustomKeys] = useState<CustomKey[]>([])
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  const [shortcutLayout, setShortcutLayout] = useState<TerminalAccessoryLayout>(
    getDefaultTerminalAccessoryLayout
  )
  const layoutWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  const layoutWriteSeqRef = useRef(0)
  const pendingLayoutWritesRef = useRef(0)

  const persistLayout = useCallback((next: TerminalAccessoryLayout) => {
    layoutWriteSeqRef.current += 1
    pendingLayoutWritesRef.current += 1
    layoutWriteChainRef.current = layoutWriteChainRef.current
      .catch(() => {})
      .then(() => saveTerminalAccessoryLayout(next))
      .catch(() => {})
      .finally(() => {
        pendingLayoutWritesRef.current -= 1
      })
  }, [])

  const refreshShortcutLayout = useCallback(() => {
    const refreshSeq = layoutWriteSeqRef.current
    void loadTerminalAccessoryLayout().then((layout) => {
      if (pendingLayoutWritesRef.current > 0 || refreshSeq !== layoutWriteSeqRef.current) {
        return
      }
      setShortcutLayout(layout)
    })
  }, [])

  const customKeysWriteChainRef = useRef<Promise<void>>(Promise.resolve())
  const customKeysWriteSeqRef = useRef(0)
  const pendingCustomKeysWritesRef = useRef(0)

  // Why: same stale-snapshot guard as persistLayout — a focus/AppState refresh
  // racing an in-flight save must not overwrite the optimistic state.
  const persistCustomKeys = useCallback((next: CustomKey[]) => {
    customKeysWriteSeqRef.current += 1
    pendingCustomKeysWritesRef.current += 1
    customKeysWriteChainRef.current = customKeysWriteChainRef.current
      .catch(() => {})
      .then(() => saveCustomKeys(next))
      .catch(() => {})
      .finally(() => {
        pendingCustomKeysWritesRef.current -= 1
      })
  }, [])

  const refreshCustomKeys = useCallback(() => {
    const refreshSeq = customKeysWriteSeqRef.current
    void loadCustomKeys().then((keys) => {
      if (pendingCustomKeysWritesRef.current > 0 || refreshSeq !== customKeysWriteSeqRef.current) {
        return
      }
      setCustomKeys(keys)
    })
  }, [])

  const handleDeleteCustomKey = useCallback(
    (key: CustomKey) => {
      setCustomKeys((current) => {
        const updated = current.filter((k) => k.id !== key.id)
        persistCustomKeys(updated)
        return updated
      })
    },
    [persistCustomKeys]
  )

  useFocusEffect(
    useCallback(() => {
      refreshShortcutLayout()
      refreshCustomKeys()
    }, [refreshShortcutLayout, refreshCustomKeys])
  )

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') {
        refreshShortcutLayout()
        refreshCustomKeys()
      }
    })
    return () => sub.remove()
  }, [refreshShortcutLayout, refreshCustomKeys])

  const toggleBuiltInKey = useCallback(
    (id: string, visible: boolean) => {
      setShortcutLayout((current) => {
        const next = setTerminalAccessoryBuiltInVisible(current, id, visible)
        persistLayout(next)
        return next
      })
    },
    [persistLayout]
  )

  const reorderKeys = useCallback(
    (orderedKeys: string[]) => {
      setShortcutLayout((current) => {
        const next = reorderTerminalAccessoryIds(current, orderedKeys)
        persistLayout(next)
        return next
      })
    },
    [persistLayout]
  )

  const resetKeys = useCallback(() => {
    setShortcutLayout((current) => {
      const next = resetTerminalAccessoryLayout(current, customKeys)
      persistLayout(next)
      return next
    })
  }, [customKeys, persistLayout])

  const visibleBuiltInSet = useMemo(
    () => new Set(shortcutLayout.visibleBuiltInIds),
    [shortcutLayout.visibleBuiltInIds]
  )
  const orderedAccessoryKeys = useMemo(
    () => getTerminalAccessoryEntries(shortcutLayout, customKeys),
    [shortcutLayout, customKeys]
  )

  return (
    <>
      <Text style={[styles.groupHeading, styles.groupTopGap]}>SHORTCUT BAR</Text>
      <Text style={styles.groupDescription}>
        Hold the grip to arrange built-in keys and custom shortcuts together. Toggle built-in keys
        to show or hide them.
      </Text>
      <View style={[styles.section, styles.sectionTopGap]}>
        <DragReorderList
          items={orderedAccessoryKeys}
          itemKey={(entry) => entry.id}
          rowHeight={REORDER_ROW_HEIGHT}
          scrollRef={scrollRef}
          scrollOffsetY={scrollOffsetY}
          scrollContentHeight={scrollContentHeight}
          onDragActiveChange={onDragActiveChange}
          onReorder={reorderKeys}
          renderRow={(entry) =>
            entry.kind === 'builtin' ? (
              <ShortcutBarRow
                shortcutKey={entry.key}
                visible={visibleBuiltInSet.has(entry.key.id)}
                onToggle={(visible) => toggleBuiltInKey(entry.key.id, visible)}
              />
            ) : (
              <View style={styles.reorderRowContent}>
                <View style={styles.keycap}>
                  <Text style={styles.keycapText}>{entry.key.label}</Text>
                </View>
                <View style={styles.rowContent}>
                  <Text style={styles.rowLabel}>{entry.key.label}</Text>
                  <Text style={styles.rowSublabel} numberOfLines={1} ellipsizeMode="tail">
                    {entry.key.bytes.replace(/\r/g, ' ↵')}
                  </Text>
                </View>
                <Pressable
                  style={({ pressed }) => [
                    styles.deleteButton,
                    pressed && styles.deleteButtonPressed
                  ]}
                  onPress={() => handleDeleteCustomKey(entry.key)}
                  accessibilityRole="button"
                  accessibilityLabel={`Delete ${entry.key.label}`}
                >
                  <X size={16} color={colors.statusRed} />
                </Pressable>
              </View>
            )
          }
        />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={resetKeys}
        >
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>Reset Defaults</Text>
            <Text style={styles.rowSublabel}>
              Restore built-in keys and place custom shortcuts after them
            </Text>
          </View>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={() => setShowCustomKeyModal(true)}
        >
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>Add Custom Shortcut…</Text>
            <Text style={styles.rowSublabel}>Create key combo or text macro</Text>
          </View>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
      </View>

      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
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

const styles = StyleSheet.create({
  groupHeading: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.textMuted,
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs
  },
  groupTopGap: {
    marginTop: spacing.xl
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
  rowPressed: {
    backgroundColor: colors.bgRaised
  },
  // Why: rows inside DragReorderList get a fixed height and a trailing grip
  // handle from the list itself, so content only pads on the left.
  reorderRowContent: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm + 2,
    paddingLeft: spacing.md + 2
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
  keycap: {
    minWidth: 62,
    alignItems: 'center',
    backgroundColor: colors.bgRaised,
    borderRadius: radii.button,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs
  },
  keycapText: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontFamily: typography.monoFamily
  },
  deleteButton: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.1)'
  },
  deleteButtonPressed: {
    backgroundColor: 'rgba(239, 68, 68, 0.2)'
  }
})
