import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ChevronRight, Minus, Plus } from 'lucide-react-native'
import type Animated from 'react-native-reanimated'
import type { AnimatedRef, SharedValue } from 'react-native-reanimated'
import { CustomKeyModal, loadCustomKeys, saveCustomKeys, type CustomKey } from './CustomKeyModal'
import { DragReorderList } from './DragReorderList'
import { TerminalShortcutReorderRow } from './terminal-shortcut-reorder-row'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { terminalSettingsScreenStyles as baseStyles } from '../terminal/terminal-settings-screen-styles'
import {
  TERMINAL_ACCESSORY_KEYS,
  type TerminalAccessoryKey
} from '../terminal/terminal-accessory-keys'
import {
  MAX_TERMINAL_ACCESSORY_ROWS,
  MIN_TERMINAL_ACCESSORY_ROWS,
  ROW_DIVIDER_ID_PREFIX,
  getDefaultTerminalAccessoryLayout,
  loadTerminalAccessoryLayout,
  parseTerminalAccessoryReorderIds,
  reconcileTerminalAccessoryLayoutCustomKeys,
  saveTerminalAccessoryLayout,
  setTerminalAccessoryBuiltInVisible,
  setTerminalAccessoryRowCount,
  updateTerminalAccessoryRows,
  type TerminalAccessoryLayout
} from '../terminal/terminal-accessory-layout'

// Why: DragReorderList absolutely positions rows, so every row in a
// reorderable section must share one fixed height.
const REORDER_ROW_HEIGHT = 56
const DEFAULT_LAYOUT = getDefaultTerminalAccessoryLayout()

type UnifiedShortcutItem =
  | { kind: 'built-in'; id: string; shortcutKey: TerminalAccessoryKey }
  | { kind: 'custom'; id: string; customKey: CustomKey }
  | { kind: 'row-divider'; id: string; rowNumber: number }

function useSequencedStorage<T>(
  initial: T | (() => T),
  load: () => Promise<T>,
  save: (value: T) => Promise<void>
) {
  const [value, setValue] = useState<T>(initial)
  const [ready, setReady] = useState(false)
  const chainRef = useRef<Promise<void>>(Promise.resolve())
  const seqRef = useRef(0)
  const pendingRef = useRef(0)
  const refreshCountRef = useRef(0)

  const commit = useCallback(
    (next: T, persist = true) => {
      seqRef.current += 1
      setValue(next)
      if (persist) {
        pendingRef.current += 1
        chainRef.current = chainRef.current
          .catch(() => {})
          .then(() => save(next))
          .catch(() => {})
          .finally(() => {
            pendingRef.current -= 1
          })
      }
    },
    [save]
  )

  const refresh = useCallback(() => {
    seqRef.current += 1
    const refreshSeq = seqRef.current
    refreshCountRef.current += 1
    setReady(false)
    void load()
      .then((loaded) => {
        if (pendingRef.current === 0 && refreshSeq === seqRef.current) {
          setValue(loaded)
        }
      })
      .catch(() => {})
      .finally(() => {
        refreshCountRef.current -= 1
        setReady(refreshCountRef.current === 0)
      })
  }, [load])

  return { value, ready, commit, refresh }
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
  const [showCustomKeyModal, setShowCustomKeyModal] = useState(false)
  const [editingCustomKey, setEditingCustomKey] = useState<CustomKey | null>(null)
  const layoutStore = useSequencedStorage<TerminalAccessoryLayout>(
    DEFAULT_LAYOUT,
    loadTerminalAccessoryLayout,
    saveTerminalAccessoryLayout
  )
  const customKeysStore = useSequencedStorage<CustomKey[]>([], loadCustomKeys, saveCustomKeys)
  const customKeys = customKeysStore.value
  const canEdit = layoutStore.ready && customKeysStore.ready

  const refreshAll = useCallback(() => {
    layoutStore.refresh()
    customKeysStore.refresh()
  }, [layoutStore.refresh, customKeysStore.refresh])

  useFocusEffect(refreshAll)

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        refreshAll()
      }
    })
    return () => sub.remove()
  }, [refreshAll])

  const customKeyIds = useMemo(() => customKeys.map((key) => key.id), [customKeys])
  const effectiveLayout = useMemo(
    () => reconcileTerminalAccessoryLayoutCustomKeys(layoutStore.value, customKeyIds),
    [layoutStore.value, customKeyIds]
  )

  const syncCustomKeys = useCallback(
    (keys: CustomKey[], persistKeys = true) => {
      if (canEdit) {
        customKeysStore.commit(keys, persistKeys)
        const nextIds = keys.map((k) => k.id)
        layoutStore.commit(reconcileTerminalAccessoryLayoutCustomKeys(layoutStore.value, nextIds))
      }
    },
    [canEdit, customKeysStore, layoutStore]
  )

  const handleUnifiedReorder = useCallback(
    (orderedIds: string[]) => {
      if (!canEdit) {
        return
      }
      const nextRows = parseTerminalAccessoryReorderIds(orderedIds, effectiveLayout.rowCount)
      const nextLayout = updateTerminalAccessoryRows(effectiveLayout, nextRows)
      layoutStore.commit(nextLayout)
      const byId = new Map(customKeys.map((key) => [key.id, key]))
      const nextCustom = nextLayout.rows.flat().flatMap((id) => byId.get(id) ?? [])
      if (nextCustom.some((key, index) => customKeys[index]?.id !== key.id)) {
        customKeysStore.commit(nextCustom)
      }
    },
    [canEdit, customKeys, customKeysStore, effectiveLayout, layoutStore]
  )

  const visibleBuiltInSet = useMemo(
    () => new Set(effectiveLayout.visibleBuiltInIds),
    [effectiveLayout.visibleBuiltInIds]
  )

  const unifiedItems = useMemo((): UnifiedShortcutItem[] => {
    const builtInById = new Map(TERMINAL_ACCESSORY_KEYS.map((key) => [key.id, key]))
    const customById = new Map(customKeys.map((key) => [key.id, key]))
    return effectiveLayout.rows.flatMap((rowIds, rowIndex) => [
      ...(rowIndex > 0
        ? [
            {
              kind: 'row-divider' as const,
              id: `${ROW_DIVIDER_ID_PREFIX}${rowIndex}__`,
              rowNumber: rowIndex + 1
            }
          ]
        : []),
      ...rowIds.flatMap((id): UnifiedShortcutItem[] => {
        const builtIn = builtInById.get(id)
        const custom = customById.get(id)
        return builtIn
          ? [{ kind: 'built-in', id, shortcutKey: builtIn }]
          : custom
            ? [{ kind: 'custom', id, customKey: custom }]
            : []
      })
    ])
  }, [effectiveLayout.rows, customKeys])

  const canDecreaseRows = canEdit && effectiveLayout.rowCount > MIN_TERMINAL_ACCESSORY_ROWS
  const canIncreaseRows = canEdit && effectiveLayout.rowCount < MAX_TERMINAL_ACCESSORY_ROWS
  const renderStepButton = (delta: -1 | 1, enabled: boolean, label: string, Icon: typeof Minus) => (
    <Pressable
      style={({ pressed }) => [
        styles.stepperButton,
        pressed && enabled && styles.stepperButtonPressed,
        !enabled && styles.stepperButtonDisabled
      ]}
      disabled={!enabled}
      onPress={() =>
        enabled &&
        layoutStore.commit(
          setTerminalAccessoryRowCount(effectiveLayout, effectiveLayout.rowCount + delta)
        )
      }
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Icon size={15} color={enabled ? colors.textPrimary : colors.textMuted} strokeWidth={2.2} />
    </Pressable>
  )
  const renderActionRow = (
    label: string,
    sublabel: string,
    onPress: () => void,
    showChevron = false
  ) => (
    <Pressable
      disabled={!canEdit}
      style={({ pressed }) => [baseStyles.row, pressed && canEdit && baseStyles.rowPressed]}
      onPress={() => canEdit && onPress()}
    >
      <View style={baseStyles.rowContent}>
        <Text style={baseStyles.rowLabel}>{label}</Text>
        <Text style={baseStyles.rowSublabel}>{sublabel}</Text>
      </View>
      {showChevron && <ChevronRight size={16} color={colors.textMuted} />}
    </Pressable>
  )

  return (
    <>
      <Text style={[baseStyles.groupHeading, baseStyles.inputGroupGap]}>SHORTCUT BAR</Text>
      <Text style={baseStyles.groupDescription}>
        Toggle keys to show or hide them, and hold the grip to drag built-in or custom shortcuts
        into any order or row on the terminal shortcut bar.
      </Text>
      <View style={[baseStyles.section, baseStyles.sectionTopGap]}>
        <View style={baseStyles.row}>
          <View style={baseStyles.rowContent}>
            <Text style={baseStyles.rowLabel}>Shortcut Rows</Text>
            <Text style={baseStyles.rowSublabel}>Stack shortcut keys across 1 to 4 rows</Text>
          </View>
          <View style={styles.stepper}>
            {renderStepButton(-1, canDecreaseRows, 'Decrease shortcut rows', Minus)}
            <Text style={styles.stepperValue}>{effectiveLayout.rowCount}</Text>
            {renderStepButton(1, canIncreaseRows, 'Increase shortcut rows', Plus)}
          </View>
        </View>
        <View style={baseStyles.separator} />
        {effectiveLayout.rowCount > 1 && (
          <>
            <View style={styles.rowDividerContent}>
              <Text style={styles.rowHeaderText}>ROW 1</Text>
            </View>
            <View style={baseStyles.separator} />
          </>
        )}
        <DragReorderList
          items={unifiedItems}
          itemKey={(item) => item.id}
          rowHeight={REORDER_ROW_HEIGHT}
          isItemDraggable={(item) => canEdit && item.kind !== 'row-divider'}
          scrollRef={scrollRef}
          scrollOffsetY={scrollOffsetY}
          scrollContentHeight={scrollContentHeight}
          onDragActiveChange={onDragActiveChange}
          onReorder={handleUnifiedReorder}
          renderRow={(item) =>
            item.kind === 'row-divider' ? (
              <View style={styles.rowDividerContent}>
                <Text style={styles.rowHeaderText}>{`ROW ${item.rowNumber}`}</Text>
              </View>
            ) : (
              <TerminalShortcutReorderRow
                item={item}
                canEdit={canEdit}
                builtInVisible={
                  item.kind === 'built-in' && visibleBuiltInSet.has(item.shortcutKey.id)
                }
                onToggleBuiltIn={(visible) => {
                  if (canEdit && item.kind === 'built-in') {
                    layoutStore.commit(
                      setTerminalAccessoryBuiltInVisible(
                        effectiveLayout,
                        item.shortcutKey.id,
                        visible
                      )
                    )
                  }
                }}
                onDeleteCustom={() =>
                  syncCustomKeys(customKeys.filter((key) => key.id !== item.id))
                }
                onEditCustom={(customKey) => {
                  setEditingCustomKey(customKey)
                  setShowCustomKeyModal(true)
                }}
              />
            )
          }
        />
        {renderActionRow(
          'Add Custom Shortcut…',
          'Create key combo or text macro',
          () => {
            setEditingCustomKey(null)
            setShowCustomKeyModal(true)
          },
          true
        )}
        <View style={baseStyles.separator} />
        {renderActionRow(
          'Reset Defaults',
          'Show every built-in shortcut key in the original order',
          () =>
            layoutStore.commit(
              reconcileTerminalAccessoryLayoutCustomKeys(DEFAULT_LAYOUT, customKeyIds)
            )
        )}
      </View>

      <CustomKeyModal
        visible={canEdit && showCustomKeyModal}
        editingKey={editingCustomKey}
        onClose={() => {
          setShowCustomKeyModal(false)
          setEditingCustomKey(null)
        }}
        onKeysChanged={(keys) => syncCustomKeys(keys, false)}
      />
    </>
  )
}

const styles = StyleSheet.create({
  rowDividerContent: {
    height: REORDER_ROW_HEIGHT,
    justifyContent: 'center',
    paddingHorizontal: spacing.md + 2,
    backgroundColor: colors.bgBase
  },
  rowHeaderText: { fontSize: 11, fontWeight: '600', color: colors.textMuted, letterSpacing: 0.5 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  stepperButton: {
    width: 32,
    height: 32,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised,
    alignItems: 'center',
    justifyContent: 'center'
  },
  stepperButtonPressed: { backgroundColor: colors.borderSubtle },
  stepperButtonDisabled: { opacity: 0.35 },
  stepperValue: {
    minWidth: 20,
    textAlign: 'center',
    fontSize: typography.bodySize,
    fontWeight: '600',
    color: colors.textPrimary,
    fontFamily: typography.monoFamily
  }
})
