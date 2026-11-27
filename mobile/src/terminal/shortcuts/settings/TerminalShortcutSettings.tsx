import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppState, Text, View, type AppStateStatus } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { CircleMinus, Trash2 } from 'lucide-react-native'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import { useDirectionPadAvailable } from '../../../layout/use-shell-side-rail'
import { CustomKeyModal } from './CustomKeyModal'
import { ListRow } from '../../../components/list/ListGroup'
import { SwipeRowActions } from '../../../components/list/SwipeRowActions'
import { PickerModal, type PickerOption } from '../../../components/sheets/PickerModal'
import { SettingsSection } from '../../../settings/settings-screen-frame'
import {
  loadCustomKeys,
  saveCustomKeys,
  type CustomKey
} from '../../key-input/terminal-custom-keys'
import { DragReorderList } from '../../../components/reorder/DragReorderList'
import { useSerializedStoredState } from '../../../storage/use-serialized-stored-state'
import { colors } from '../../../theme/mobile-theme'
import { styles } from './terminal-shortcut-settings-styles'
import { useMobileColorScheme } from '../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../i18n/use-mobile-translation'
import '../../key-input/terminal-accessory-keys'
import { TERMINAL_ACCESSORY_KEY_DEFINITIONS as TERMINAL_ACCESSORY_KEYS } from '../../key-input/terminal-key-definitions'
import {
  getDefaultTerminalAccessoryLayout,
  loadTerminalAccessoryLayout,
  reorderTerminalAccessoryBuiltInIds,
  saveTerminalAccessoryLayout,
  setTerminalAccessoryBuiltInVisible
} from '../../key-input/terminal-accessory-layout'
import { MobileSwitch } from '../../../components/controls/MobileSwitch'
import { customKeyBytes, keyName, withVisibleOrder } from './terminal-key-row-entries'
import { SmartRailRow } from '../../../components/list/SmartRailRow'

// Absolutely positioned DragReorderList rows require one fixed height per list.
const KEY_ROW_HEIGHT = 48
const CUSTOM_KEY_ROW_HEIGHT = 60
const NEW_KEY = '\u0000new'

type Props = {
  /** Rows show grips and drag instead of swiping. */
  editing: boolean
  scrollRef: AnimatedRef<Animated.ScrollView>
  scrollOffsetY: SharedValue<number>
  scrollContentHeight: SharedValue<number>
  onDragActiveChange: (active: boolean) => void
}

/** The Key row page: the keys under ⋯ and your own keys, then the row's switches. */
export function TerminalShortcutSettings({
  editing,
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
  const [addPickerOpen, setAddPickerOpen] = useState(false)
  // A new key's sheet waits for the picker to finish closing: iOS presents one sheet at a time.
  const [newKeyAfterPicker, setNewKeyAfterPicker] = useState(false)
  const {
    value: shortcutLayout,
    setValue: setShortcutLayout,
    persist: persistLayout,
    refresh: refreshShortcutLayout
  } = useSerializedStoredState(defaultLayout, loadShortcutLayout, saveTerminalAccessoryLayout)

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

  const updateLayout = useCallback(
    (change: (current: typeof shortcutLayout) => typeof shortcutLayout) =>
      setShortcutLayout((current) => {
        const next = change(current)
        persistLayout(next)
        return next
      }),
    [persistLayout]
  )

  const updateCustomKeys = useCallback(
    (change: (current: CustomKey[]) => CustomKey[]) =>
      setCustomKeys((current) => {
        const next = change(current)
        if (next !== current) {
          persistCustomKeys(next)
        }
        return next
      }),
    [persistCustomKeys]
  )

  const { shownKeys, hiddenKeys } = useMemo(() => {
    const byId = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
    const visible = new Set(shortcutLayout.visibleBuiltInIds)
    const ordered = shortcutLayout.orderedBuiltInIds.flatMap((id) => {
      const key = byId.get(id)
      return key ? [key] : []
    })
    return {
      shownKeys: ordered.filter((key) => visible.has(key.id)),
      hiddenKeys: ordered.filter((key) => !visible.has(key.id))
    }
  }, [shortcutLayout.orderedBuiltInIds, shortcutLayout.visibleBuiltInIds])
  const shownCustomKeys = customKeys.filter((key) => key.visible !== false)
  const hiddenCustomKeys = customKeys.filter((key) => key.visible === false)

  const reorderShownKeys = useCallback(
    (orderedKeys: string[]) =>
      updateLayout((current) =>
        reorderTerminalAccessoryBuiltInIds(
          current,
          withVisibleOrder(
            current.orderedBuiltInIds,
            new Set(current.visibleBuiltInIds),
            orderedKeys
          )
        )
      ),
    [updateLayout]
  )

  const reorderCustomKeys = useCallback(
    (orderedKeys: string[]) =>
      updateCustomKeys((current) => {
        const ids = withVisibleOrder(
          current.map((key) => key.id),
          new Set(current.filter((key) => key.visible !== false).map((key) => key.id)),
          orderedKeys
        )
        const byId = new Map(current.map((key) => [key.id, key]))
        const reordered = ids.flatMap((id) => {
          const key = byId.get(id)
          return key ? [key] : []
        })
        return reordered.length === current.length ? reordered : current
      }),
    [updateCustomKeys]
  )

  // Removed keys come back from Add a key, so it lists them before a new one.
  const addOptions: PickerOption[] = [
    ...hiddenKeys.map((key) => {
      const { title, glyph } = keyName(key)
      return { value: `builtin:${key.id}`, label: title, subtitle: glyph }
    }),
    ...hiddenCustomKeys.map((key) => ({
      value: `custom:${key.id}`,
      label: key.label,
      subtitle: customKeyBytes(key)
    })),
    {
      value: NEW_KEY,
      label: t('components.terminalShortcutSettings.newKey', 'New key…')
    }
  ]
  const addKey = (value: string) => {
    setAddPickerOpen(false)
    if (value === NEW_KEY) {
      setNewKeyAfterPicker(true)
    } else if (value.startsWith('builtin:')) {
      const id = value.slice('builtin:'.length)
      updateLayout((current) => setTerminalAccessoryBuiltInVisible(current, id, true))
    } else {
      const id = value.slice('custom:'.length)
      updateCustomKeys((current) =>
        current.map((key) => (key.id === id ? { ...key, visible: true } : key))
      )
    }
  }

  const removeLabel = t('components.terminalShortcutSettings.remove', 'Remove')
  const deleteLabel = t('components.terminalShortcutSettings.delete', 'Delete')

  return (
    <>
      <SettingsSection
        first
        title={t('components.terminalShortcutSettings.moreKeys', 'More keys')}
        footer={
          editing
            ? undefined
            : t(
                'components.terminalShortcutSettings.swipeToRemove',
                'Swipe a key left to remove it.'
              )
        }
      >
        {editing ? (
          <DragReorderList
            key="builtIn"
            items={shownKeys}
            itemKey={(key) => key.id}
            rowHeight={KEY_ROW_HEIGHT}
            scrollRef={scrollRef}
            scrollOffsetY={scrollOffsetY}
            scrollContentHeight={scrollContentHeight}
            onDragActiveChange={onDragActiveChange}
            onReorder={reorderShownKeys}
            renderRow={(key) => {
              const { title, glyph } = keyName(key)
              return (
                <View style={styles.reorderRowContent}>
                  <Text style={[styles.rowLabel, styles.rowContent]} numberOfLines={1}>
                    {title}
                  </Text>
                  {glyph ? <Text style={styles.rowValue}>{glyph}</Text> : null}
                </View>
              )
            }}
          />
        ) : (
          shownKeys.map((key) => {
            const { title, glyph } = keyName(key)
            return (
              <SwipeRowActions
                key={key.id}
                trailing={{
                  label: removeLabel,
                  accessibilityLabel: t(
                    'components.terminalShortcutSettings.removeShortcut',
                    'Remove {{label}}',
                    { label: title }
                  ),
                  icon: CircleMinus,
                  background: colors.textMuted,
                  foreground: colors.onAccent,
                  onPress: () =>
                    updateLayout((current) =>
                      setTerminalAccessoryBuiltInVisible(current, key.id, false)
                    )
                }}
              >
                {() => <ListRow title={title} value={glyph} />}
              </SwipeRowActions>
            )
          })
        )}
        {editing ? null : (
          <ListRow
            key="add"
            title={t('components.terminalShortcutSettings.addKey', 'Add a key')}
            accent
            onPress={() =>
              addOptions.length > 1 ? setAddPickerOpen(true) : setShowCustomKeyModal(true)
            }
          />
        )}
      </SettingsSection>

      {shownCustomKeys.length > 0 ? (
        <SettingsSection title={t('components.terminalShortcutSettings.yourKeys', 'Your keys')}>
          {editing ? (
            <DragReorderList
              key="custom"
              items={shownCustomKeys}
              itemKey={(key) => key.id}
              rowHeight={CUSTOM_KEY_ROW_HEIGHT}
              scrollRef={scrollRef}
              scrollOffsetY={scrollOffsetY}
              scrollContentHeight={scrollContentHeight}
              onDragActiveChange={onDragActiveChange}
              onReorder={reorderCustomKeys}
              renderRow={(key) => (
                <View style={styles.reorderRowContent}>
                  <View style={styles.rowContent}>
                    <Text style={[styles.rowLabel, styles.rowLabelEmphasis]} numberOfLines={1}>
                      {key.label}
                    </Text>
                    <Text style={styles.rowSublabel} numberOfLines={1}>
                      {customKeyBytes(key)}
                    </Text>
                  </View>
                </View>
              )}
            />
          ) : (
            shownCustomKeys.map((key) => (
              <SwipeRowActions
                key={key.id}
                // Remove takes it off the row (Add a key brings it back); Delete forgets it.
                trailing={[
                  {
                    label: removeLabel,
                    accessibilityLabel: t(
                      'components.terminalShortcutSettings.removeShortcut',
                      'Remove {{label}}',
                      { label: key.label }
                    ),
                    icon: CircleMinus,
                    background: colors.textMuted,
                    foreground: colors.onAccent,
                    onPress: () =>
                      updateCustomKeys((current) =>
                        current.map((k) => (k.id === key.id ? { ...k, visible: false } : k))
                      )
                  },
                  {
                    label: deleteLabel,
                    accessibilityLabel: t(
                      'components.terminalShortcutSettings.deleteKey',
                      'Delete {{label}}',
                      { label: key.label }
                    ),
                    icon: Trash2,
                    background: colors.statusRed,
                    foreground: colors.onStatusRed,
                    onPress: () =>
                      updateCustomKeys((current) => current.filter((k) => k.id !== key.id))
                  }
                ]}
              >
                {() => <ListRow title={key.label} />}
              </SwipeRowActions>
            ))
          )}
        </SettingsSection>
      ) : null}

      {editing ? null : (
        <>
          <SettingsSection>
            <SmartRailRow
              key="smartRail"
              enabled={shortcutLayout.smartRail === true}
              onChange={(enabled) =>
                updateLayout((current) => ({ ...current, smartRail: enabled }))
              }
            />
            {hasPad ? (
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
                      updateLayout((current) => ({ ...current, directionPadEnabled: enabled }))
                    }
                  />
                }
              />
            ) : null}
          </SettingsSection>

          <SettingsSection>
            <ListRow
              key="reset"
              title={t('components.terminalShortcutSettings.resetKeys', 'Reset keys')}
              onPress={() =>
                // Resetting the keys leaves the Smart rail setting alone.
                updateLayout((current) => ({ ...defaultLayout(), smartRail: current.smartRail }))
              }
            />
          </SettingsSection>
        </>
      )}

      <PickerModal
        visible={addPickerOpen}
        title={t('components.terminalShortcutSettings.addKey', 'Add a key')}
        options={addOptions}
        selected=""
        onSelect={addKey}
        onClose={() => setAddPickerOpen(false)}
        onAfterClose={() => {
          if (newKeyAfterPicker) {
            setNewKeyAfterPicker(false)
            setShowCustomKeyModal(true)
          }
        }}
      />
      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
        onKeysChanged={adoptStoredCustomKeys}
      />
    </>
  )
}
