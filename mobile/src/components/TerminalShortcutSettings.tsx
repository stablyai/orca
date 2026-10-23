import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppState, View, Text, StyleSheet, type AppStateStatus } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Plus, RotateCcw, Trash2 } from 'lucide-react-native'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import { CustomKeyModal } from './CustomKeyModal'
import { ConfirmModal } from './ConfirmModal'
import { MobileSwitch } from './MobileSwitch'
import { IconButton } from './ui/IconButton'
import { ListGroup, LIST_LEADING_INSET } from './ui/ListGroup'
import { ListRow } from './ui/ListRow'
import { SectionHeader } from './ui/SectionHeader'
import { loadCustomKeys, saveCustomKeys, type CustomKey } from '../terminal/terminal-custom-keys'
import { DragReorderList } from './DragReorderList'
import { useSerializedStoredState } from '../storage/use-serialized-stored-state'
import { colors, radii, spacing, textStyles, typography } from '../theme/mobile-theme'
import { triggerSelection } from '../platform/haptics'
import { SettingsFooter, SettingsRowIcon } from '../settings/settings-screen-frame'
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

// Why: DragReorderList absolutely positions rows, so every row in a
// reorderable section must share one fixed height.
const REORDER_ROW_HEIGHT = 56

function Keycap({ label }: { label: string }): React.JSX.Element {
  return (
    <View style={styles.keycap}>
      <Text style={styles.keycapText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

function ShortcutBarRow({
  shortcutKey,
  visible,
  onToggle
}: {
  shortcutKey: TerminalAccessoryKey
  visible: boolean
  onToggle: (visible: boolean) => void
}): React.JSX.Element {
  const name = shortcutKey.accessibilityLabel ?? shortcutKey.label
  return (
    <View style={styles.reorderRowContent}>
      <Keycap label={shortcutKey.label} />
      <Text style={styles.rowLabel} numberOfLines={1}>
        {name}
      </Text>
      <MobileSwitch
        value={visible}
        onValueChange={(next) => {
          triggerSelection()
          onToggle(next)
        }}
        accessibilityLabel={`Show ${name} in the shortcut bar`}
      />
    </View>
  )
}

async function loadShortcutLayout(): Promise<TerminalAccessoryLayout> {
  const { orderedBuiltInIds, visibleBuiltInIds } = await loadTerminalAccessoryLayout()
  return { orderedBuiltInIds, visibleBuiltInIds }
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
  const {
    value: customKeys,
    setValue: setCustomKeys,
    persist: persistCustomKeys,
    refresh: refreshCustomKeys,
    adoptStored: adoptStoredCustomKeys
  } = useSerializedStoredState<CustomKey[]>([], loadCustomKeys, saveCustomKeys)
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  // The target outlives the sheet's close so its title doesn't blank while it slides away.
  const [pendingDelete, setPendingDelete] = useState<CustomKey | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const {
    value: shortcutLayout,
    setValue: setShortcutLayout,
    persist: persistLayout,
    refresh: refreshShortcutLayout
  } = useSerializedStoredState(
    getDefaultTerminalAccessoryLayout,
    loadShortcutLayout,
    saveTerminalAccessoryLayout
  )

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
      <SectionHeader title="Shortcut bar" />
      <View style={styles.reorderGroup}>
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
        <ListRow
          title="Reset defaults"
          destructive
          leading={<SettingsRowIcon icon={RotateCcw} color={colors.danger} />}
          onPress={() => setConfirmReset(true)}
        />
      </View>
      <SettingsFooter>Hold the grip to reorder keys. Turn a key off to hide it.</SettingsFooter>

      <SectionHeader title="Custom shortcuts" />
      {customKeys.length === 0 ? (
        <ListGroup separatorInset={LIST_LEADING_INSET}>
          <ListRow title="No custom shortcuts yet" />
          <ListRow
            title="Add custom shortcut…"
            leading={<SettingsRowIcon icon={Plus} />}
            onPress={() => setShowCustomKeyModal(true)}
          />
        </ListGroup>
      ) : (
        <View style={styles.reorderGroup}>
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
                <Keycap label={key.label} />
                <Text style={styles.bytes} numberOfLines={1} ellipsizeMode="tail">
                  {key.bytes.replace(/\r/g, ' ↵')}
                </Text>
                <IconButton
                  icon={Trash2}
                  variant="bare"
                  iconSize={18}
                  iconColor={colors.danger}
                  accessibilityLabel={`Remove ${key.label}`}
                  onPress={() => {
                    setPendingDelete(key)
                    setConfirmDelete(true)
                  }}
                />
              </View>
            )}
          />
          <ListRow
            title="Add custom shortcut…"
            leading={<SettingsRowIcon icon={Plus} />}
            onPress={() => setShowCustomKeyModal(true)}
          />
        </View>
      )}
      <SettingsFooter>A key combo or a text macro, sent with one tap.</SettingsFooter>

      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
        onKeysChanged={adoptStoredCustomKeys}
      />
      <ConfirmModal
        visible={confirmDelete}
        title={pendingDelete ? `Delete “${pendingDelete.label}”?` : ''}
        message="It is removed from the shortcut bar on this phone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (pendingDelete) {
            handleDeleteCustomKey(pendingDelete)
          }
        }}
        onCancel={() => setConfirmDelete(false)}
      />
      <ConfirmModal
        visible={confirmReset}
        title="Reset the shortcut bar?"
        message="Every built-in key comes back, in its original order."
        confirmLabel="Reset"
        destructive
        onConfirm={resetBuiltInKeys}
        onCancel={() => setConfirmReset(false)}
      />
    </>
  )
}

const styles = StyleSheet.create({
  // ListGroup's inset look; DragReorderList draws its own row hairlines, so the group must not.
  reorderGroup: {
    marginHorizontal: spacing.lg,
    borderRadius: radii.group,
    backgroundColor: colors.groupFill,
    overflow: 'hidden'
  },
  // Why: rows inside DragReorderList get a fixed height and a trailing grip
  // handle from the list itself, so content only pads on the left.
  reorderRowContent: {
    flex: 1,
    height: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingLeft: spacing.lg
  },
  rowLabel: { ...textStyles.body, flex: 1, minWidth: 0, color: colors.textPrimary },
  bytes: {
    flex: 1,
    minWidth: 0,
    fontSize: 13,
    lineHeight: 18,
    fontFamily: typography.monoFamily,
    color: colors.textSecondary
  },
  keycap: {
    minWidth: 56,
    maxWidth: 140,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.fill,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
    flexShrink: 0
  },
  keycapText: {
    color: colors.textPrimary,
    fontSize: 13,
    fontFamily: typography.monoFamily
  }
})
