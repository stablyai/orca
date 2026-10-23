import { ListTodo, Plus } from 'lucide-react-native'
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg'
import { PickerModal } from '../components/PickerModal'
import { Button } from '../components/ui/Button'
import { useConnectedHostPicker } from '../components/use-connected-host-picker'
import { colors, spacing, textStyles } from '../theme/mobile-theme'
import type { HostProfile } from '../transport/types'
import { homeDesktopPickerOptions } from './home-desktop-picker-options'

const FADE_HEIGHT = spacing.xl
const FADE_ID = 'home-bottom-bar-fade'

/**
 * Tasks and New workspace under the thumb, pinned over the list's bottom edge. The fade above it
 * lets rows scroll under instead of being cut off.
 */
export function MobileHomeBottomBar(props: {
  connectedHosts: HostProfile[]
  bottomInset: number
  contentMaxWidth: number
  isWideLayout: boolean
  onOpenTasks: (hostId: string) => void
  onCreateWorkspace: () => void
  onLayout: (event: LayoutChangeEvent) => void
}) {
  const tasksHostPicker = useConnectedHostPicker(props.connectedHosts)
  const offeredHostIds = new Set(tasksHostPicker.pickerProps.options.map((option) => option.value))
  const enabled = props.connectedHosts.length > 0
  const disabledHint = enabled ? undefined : 'Connect a desktop first.'

  return (
    <View
      style={[styles.bar, { paddingBottom: Math.max(props.bottomInset, spacing.lg) }]}
      onLayout={props.onLayout}
    >
      <View pointerEvents="none" style={styles.fade}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id={FADE_ID} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={colors.bgBase} stopOpacity={0} />
              <Stop offset="1" stopColor={colors.bgBase} stopOpacity={1} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill={`url(#${FADE_ID})`} />
        </Svg>
      </View>
      <View
        style={[
          styles.inner,
          props.isWideLayout && { maxWidth: props.contentMaxWidth, alignSelf: 'center' }
        ]}
      >
        {enabled ? null : <Text style={styles.hint}>Connect a desktop to start work.</Text>}
        <View style={styles.buttons}>
          <View style={styles.slot}>
            <Button
              label="Tasks"
              icon={ListTodo}
              variant="secondary"
              block
              disabled={!enabled}
              accessibilityHint={disabledHint}
              onPress={() => tasksHostPicker.pickHost(props.onOpenTasks)}
            />
          </View>
          <View style={styles.slot}>
            <Button
              label="New workspace"
              icon={Plus}
              variant="primary"
              block
              disabled={!enabled}
              accessibilityHint={disabledHint}
              onPress={props.onCreateWorkspace}
            />
          </View>
        </View>
      </View>
      <PickerModal
        title="Open tasks on"
        {...tasksHostPicker.pickerProps}
        options={homeDesktopPickerOptions(
          props.connectedHosts.filter((host) => offeredHostIds.has(host.id))
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: spacing.md,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.bgBase
  },
  fade: { position: 'absolute', left: 0, right: 0, top: -FADE_HEIGHT, height: FADE_HEIGHT },
  inner: { width: '100%', gap: spacing.sm },
  hint: { ...textStyles.footnote, color: colors.textMuted, textAlign: 'center' },
  buttons: { flexDirection: 'row', gap: 10 },
  // Why: each grows from its own width, so "New workspace" never truncates on a narrow phone.
  slot: { flexGrow: 1, flexBasis: 'auto', minWidth: 0 }
})
