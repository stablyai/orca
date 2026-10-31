import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppState, View, Text, Pressable, type AppStateStatus } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ChevronRight, X } from 'lucide-react-native'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import { useDirectionPadAvailable } from '../layout/use-shell-side-rail'
import { CustomKeyModal } from './CustomKeyModal'
import { loadCustomKeys, saveCustomKeys, type CustomKey } from '../terminal/terminal-custom-keys'
import { DragReorderList } from './DragReorderList'
import { useSerializedStoredState } from '../storage/use-serialized-stored-state'
import { colors } from '../theme/mobile-theme'
import { styles } from './terminal-shortcut-settings-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import {
  TERMINAL_ACCESSORY_KEYS,
  type TerminalAccessoryKey
} from '../terminal/terminal-accessory-keys'
import {
  getDefaultTerminalAccessoryLayout,
  loadTerminalAccessoryLayout,
  reorderTerminalAccessoryBuiltInIds,
  saveTerminalAccessoryLayout,
  setTerminalAccessoryBuiltInVisible
} from '../terminal/terminal-accessory-layout'
import { MobileSwitch } from './MobileSwitch'

// Absolutely positioned DragReorderList rows require one fixed height per section.
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.reorderRowContent}>
      <View style={styles.keycap}>
        <Text style={styles.keycapText}>{shortcutKey.label}</Text>
      </View>
      <View style={styles.rowContent}>
        <Text style={styles.rowLabel}>{shortcutKey.accessibilityLabel ?? shortcutKey.label}</Text>
      </View>
      <MobileSwitch
        accessibilityLabel={t(
          'components.terminalShortcutSettings.showShortcut',
          'Show {{label}} shortcut',
          {
            label: shortcutKey.accessibilityLabel ?? shortcutKey.label
          }
        )}
        value={visible}
        onValueChange={onToggle}
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const hasPad = useDirectionPadAvailable()
  const defaultLayout = useCallback(() => getDefaultTerminalAccessoryLayout(hasPad), [hasPad])
  const loadShortcutLayout = useCallback(() => loadTerminalAccessoryLayout(hasPad), [hasPad])
  const {
    value: customKeys,
    setValue: setCustomKeys,
    persist: persistCustomKeys,
    refresh: refreshCustomKeys,
    adoptStored: adoptStoredCustomKeys
  } = useSerializedStoredState<CustomKey[]>([], loadCustomKeys, saveCustomKeys)
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  const {
    value: shortcutLayout,
    setValue: setShortcutLayout,
    persist: persistLayout,
    refresh: refreshShortcutLayout
  } = useSerializedStoredState(defaultLayout, loadShortcutLayout, saveTerminalAccessoryLayout)

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
    const next = defaultLayout()
    setShortcutLayout(next)
    persistLayout(next)
  }, [defaultLayout, persistLayout])

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

  const orderedAccessoryKeys = useMemo(() => {
    const byId = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
    return shortcutLayout.orderedBuiltInIds.flatMap((id) => {
      const key = byId.get(id)
      return key ? [key] : []
    })
  }, [shortcutLayout.orderedBuiltInIds])

  return (
    <>
      {hasPad ? (
        <>
          <Text style={[styles.groupHeading, styles.groupTopGap]}>
            {t('components.terminalShortcutSettings.directionPad', 'DIRECTION PAD')}
          </Text>
          <View style={[styles.section, styles.sectionTopGap]}>
            <View style={styles.row}>
              <View style={styles.rowContent}>
                <Text style={styles.rowLabel}>
                  {t('components.terminalShortcutSettings.showDirectionPad', 'Show D-pad')}
                </Text>
                <Text style={styles.rowSublabel}>
                  {t(
                    'components.terminalShortcutSettings.showDirectionPadDescription',
                    'Pin the arrow pad in the side rail. Without it, the rail lists the arrow keys.'
                  )}
                </Text>
              </View>
              <MobileSwitch
                accessibilityLabel={t(
                  'components.terminalShortcutSettings.showDirectionPad',
                  'Show D-pad'
                )}
                value={shortcutLayout.directionPadEnabled !== false}
                onValueChange={(enabled) =>
                  setShortcutLayout((current) => {
                    const next = { ...current, directionPadEnabled: enabled }
                    persistLayout(next)
                    return next
                  })
                }
              />
            </View>
          </View>
        </>
      ) : null}
      <Text style={[styles.groupHeading, styles.groupTopGap]}>
        {t('components.terminalShortcutSettings.moreKeys', 'MORE KEYS')}
      </Text>
      <Text style={styles.groupDescription}>
        {t(
          'components.terminalShortcutSettings.moreKeysDescription',
          'These keys sit under ⋯ on the terminal key row. Toggle keys to show or hide them, and hold the grip to drag a key into the order you want. A key already on the row, like Esc or the arrows, is left out of ⋯.'
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
              visible={shortcutLayout.visibleBuiltInIds.includes(shortcutKey.id)}
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
              {t('components.terminalShortcutSettings.resetDefaults', 'Reset Defaults')}
            </Text>
            <Text style={styles.rowSublabel}>
              {t(
                'components.terminalShortcutSettings.resetDescription',
                'Show every built-in shortcut key in the original order'
              )}
            </Text>
          </View>
        </Pressable>
      </View>

      <Text style={[styles.groupHeading, styles.groupTopGap]}>
        {t('components.terminalShortcutSettings.customShortcuts', 'CUSTOM SHORTCUTS')}
      </Text>
      <View style={[styles.section, styles.sectionTopGap]}>
        {customKeys.length === 0 ? (
          <>
            <View style={styles.emptyContainer}>
              <Text style={styles.emptyText}>
                {t('components.terminalShortcutSettings.empty', 'No custom shortcuts defined yet.')}
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
                <MobileSwitch
                  accessibilityLabel={t(
                    'components.terminalShortcutSettings.showShortcut',
                    'Show {{label}} shortcut',
                    {
                      label: key.label
                    }
                  )}
                  value={key.visible !== false}
                  onValueChange={(visible) =>
                    setCustomKeys((current) => {
                      const next = current.map((item) =>
                        item.id === key.id ? { ...item, visible } : item
                      )
                      persistCustomKeys(next)
                      return next
                    })
                  }
                />
                <Pressable
                  style={({ pressed }) => [
                    styles.deleteButton,
                    pressed && styles.deleteButtonPressed
                  ]}
                  onPress={() => handleDeleteCustomKey(key)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t(
                    'components.terminalShortcutSettings.removeShortcut',
                    'Remove {{label}}',
                    { label: key.label }
                  )}
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
              {t('components.terminalShortcutSettings.addShortcut', 'Add Custom Shortcut…')}
            </Text>
            <Text style={styles.rowSublabel}>
              {t(
                'components.terminalShortcutSettings.addDescription',
                'Create key combo or text macro'
              )}
            </Text>
          </View>
          <ChevronRight size={16} color={colors.textMuted} />
        </Pressable>
      </View>

      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
        onKeysChanged={adoptStoredCustomKeys}
      />
    </>
  )
}
