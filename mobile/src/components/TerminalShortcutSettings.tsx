import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, View, Text, Pressable, Switch, type AppStateStatus } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ChevronRight, X } from 'lucide-react-native'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import { CustomKeyModal, loadCustomKeys, saveCustomKeys, type CustomKey } from './CustomKeyModal'
import { DragReorderList } from './DragReorderList'
import { colors } from '../theme/mobile-theme'
import {
  TERMINAL_ACCESSORY_KEYS,
  type TerminalAccessoryKey
} from '../terminal/terminal-accessory-keys'
import {
  getDefaultTerminalAccessoryLayout,
  loadTerminalAccessoryLayout,
  reorderTerminalAccessoryBuiltInIds,
  saveTerminalAccessoryLayout,
  setTerminalAccessoryBuiltInVisible,
  type TerminalAccessoryLayout
} from '../terminal/terminal-accessory-layout'
import { useTranslate } from '../i18n/useTranslate'
import { styles } from './terminal-shortcut-settings-styles'

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
  const { t } = useTranslate()
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
      setShortcutLayout({
        orderedBuiltInIds: layout.orderedBuiltInIds,
        visibleBuiltInIds: layout.visibleBuiltInIds
      })
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

  const reorderBuiltInKeys = useCallback(
    (orderedKeys: string[]) => {
      setShortcutLayout((current) => {
        const next = reorderTerminalAccessoryBuiltInIds(current, orderedKeys)
        persistLayout(next)
        return next
      })
    },
    [persistLayout]
  )

  const resetBuiltInKeys = useCallback(() => {
    const next = getDefaultTerminalAccessoryLayout()
    setShortcutLayout(next)
    persistLayout(next)
  }, [persistLayout])

  const reorderCustomKeys = useCallback(
    (orderedKeys: string[]) => {
      setCustomKeys((current) => {
        const byId = new Map(current.map((key) => [key.id, key]))
        const reordered = orderedKeys.flatMap((id) => {
          const key = byId.get(id)
          return key ? [key] : []
        })
        if (reordered.length !== current.length) {
          return current
        }
        persistCustomKeys(reordered)
        return reordered
      })
    },
    [persistCustomKeys]
  )

  const visibleBuiltInSet = useMemo(
    () => new Set(shortcutLayout.visibleBuiltInIds),
    [shortcutLayout.visibleBuiltInIds]
  )
  const orderedAccessoryKeys = useMemo(() => {
    const byId = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
    return shortcutLayout.orderedBuiltInIds.flatMap((id) => {
      const key = byId.get(id)
      return key ? [key] : []
    })
  }, [shortcutLayout.orderedBuiltInIds])

  return (
    <>
      <Text style={[styles.groupHeading, styles.groupTopGap]}>
        {t('mobile.terminalShortcut.groupHeading', 'SHORTCUT BAR')}
      </Text>
      <Text style={styles.groupDescription}>
        {t(
          'mobile.terminalShortcut.groupDescription',
          'Toggle keys to show or hide them, and hold the grip to drag a key into the order you want on the terminal shortcut bar.'
        )}
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
              visible={visibleBuiltInSet.has(shortcutKey.id)}
              onToggle={(visible) => toggleBuiltInKey(shortcutKey.id, visible)}
            />
          )}
        />
        <Pressable
          style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
          onPress={resetBuiltInKeys}
        >
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>
              {t('mobile.terminalShortcut.resetDefaults', 'Reset Defaults')}
            </Text>
            <Text style={styles.rowSublabel}>
              {t(
                'mobile.terminalShortcut.resetDefaultsHint',
                'Show every built-in shortcut key in the original order'
              )}
            </Text>
          </View>
        </Pressable>
      </View>

      <Text style={[styles.groupHeading, styles.groupTopGap]}>
        {t('mobile.terminalShortcut.customGroupHeading', 'CUSTOM SHORTCUTS')}
      </Text>
      <View style={[styles.section, styles.sectionTopGap]}>
        {customKeys.length === 0 ? (
          <>
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>
                {t('mobile.terminalShortcut.empty', 'No custom shortcuts defined yet.')}
              </Text>
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
          onPress={() => setShowCustomKeyModal(true)}
        >
          <View style={styles.rowContent}>
            <Text style={styles.rowLabel}>
              {t('mobile.terminalShortcut.addCustom', 'Add Custom Shortcut…')}
            </Text>
            <Text style={styles.rowSublabel}>
              {t('mobile.terminalShortcut.addCustomHint', 'Create key combo or text macro')}
            </Text>
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
