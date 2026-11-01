import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppState, View, Text, Pressable, type AppStateStatus } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { X } from 'lucide-react-native'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import { useDirectionPadAvailable } from '../layout/use-shell-side-rail'
import { CustomKeyModal } from './CustomKeyModal'
import { ListRow } from './list/ListGroup'
import { SettingsEmptyRow, SettingsSection } from '../settings/settings-screen-frame'
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
        <SettingsSection
          title={t('components.terminalShortcutSettings.directionPad', 'DIRECTION PAD')}
        >
          <ListRow
            key="directionPad"
            title={t('components.terminalShortcutSettings.showDirectionPad', 'Show D-pad')}
            subtitle={t(
              'components.terminalShortcutSettings.showDirectionPadDescription',
              'Pin the arrow pad in the side rail. Without it, the rail lists the arrow keys.'
            )}
            accessory={
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
            }
          />
        </SettingsSection>
      ) : null}
      <SettingsSection
        title={t('components.terminalShortcutSettings.moreKeys', 'MORE KEYS')}
        footer={t(
          'components.terminalShortcutSettings.moreKeysDescription',
          'These keys sit under ⋯ on the terminal key row. Toggle keys to show or hide them, and hold the grip to drag a key into the order you want. A key already on the row, like Esc or the arrows, is left out of ⋯.'
        )}
      >
        <DragReorderList
          key="builtIn"
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
        <ListRow
          key="reset"
          title={t('components.terminalShortcutSettings.resetDefaults', 'Reset Defaults')}
          subtitle={t(
            'components.terminalShortcutSettings.resetDescription',
            'Show every built-in shortcut key in the original order'
          )}
          onPress={resetBuiltInKeys}
        />
      </SettingsSection>

      <SettingsSection
        title={t('components.terminalShortcutSettings.customShortcuts', 'CUSTOM SHORTCUTS')}
      >
        {customKeys.length === 0 ? (
          <SettingsEmptyRow key="empty">
            {t('components.terminalShortcutSettings.empty', 'No custom shortcuts defined yet.')}
          </SettingsEmptyRow>
        ) : (
          <DragReorderList
            key="custom"
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
        <ListRow
          key="add"
          title={t('components.terminalShortcutSettings.addShortcut', 'Add Custom Shortcut…')}
          subtitle={t(
            'components.terminalShortcutSettings.addDescription',
            'Create key combo or text macro'
          )}
          navigates
          onPress={() => setShowCustomKeyModal(true)}
        />
      </SettingsSection>

      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
        onKeysChanged={adoptStoredCustomKeys}
      />
    </>
  )
}
