import { memo, useCallback, useRef } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Monitor } from 'lucide-react-native'
import Animated, {
  useAnimatedRef,
  useAnimatedScrollHandler,
  useSharedValue
} from 'react-native-reanimated'
import { BottomDrawer } from '../components/BottomDrawer'
import { DragReorderList } from '../components/DragReorderList'
import { setTerminalSettingsScrollEnabled } from '../terminal/terminal-settings-scroll-lock'
import { colors, spacing } from '../theme/mobile-theme'
import type { HostCatalogEntry } from '../transport/types'
import { useHostDisplay } from '../transport/use-host-display'

export const MobileHomeHostOrderDrawer = memo(function MobileHomeHostOrderDrawer(props: {
  visible: boolean
  hosts: HostCatalogEntry[]
  onReorder: (ids: string[]) => void
  onClose: () => void
}) {
  return (
    <BottomDrawer
      visible={props.visible}
      onClose={props.onClose}
      contentScrollable={false}
      dragContentToDismiss={false}
      fillAvailable
    >
      <HostOrderContent {...props} />
    </BottomDrawer>
  )
})

function HostOrderContent({
  hosts,
  onReorder,
  onClose
}: {
  hosts: HostCatalogEntry[]
  onReorder: (ids: string[]) => void
  onClose: () => void
}) {
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const scrollOffsetY = useSharedValue(0)
  const scrollContentHeight = useSharedValue(0)
  const draggingRef = useRef(false)
  const scrollHandler = useAnimatedScrollHandler((event) => {
    scrollOffsetY.value = event.contentOffset.y
  })
  const handleDragActiveChange = useCallback(
    (active: boolean) => {
      draggingRef.current = active
      setTerminalSettingsScrollEnabled(scrollRef, !active)
    },
    [scrollRef]
  )

  return (
    <View style={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Reorder desktops</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done reordering desktops"
          hitSlop={8}
          onPress={() => {
            if (!draggingRef.current) {
              onClose()
            }
          }}
        >
          <Text style={styles.done}>Done</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>
        Hold a handle and drag. Your order stays the same when connections change.
      </Text>
      <Animated.ScrollView
        ref={scrollRef}
        style={styles.scroll}
        onScroll={scrollHandler}
        scrollEventThrottle={16}
        onContentSizeChange={(_width, height) => {
          scrollContentHeight.value = height
        }}
      >
        <DragReorderList
          items={hosts}
          itemKey={(host) => host.id}
          rowHeight={72}
          scrollRef={scrollRef}
          scrollOffsetY={scrollOffsetY}
          scrollContentHeight={scrollContentHeight}
          onDragActiveChange={handleDragActiveChange}
          onReorder={onReorder}
          renderRow={(host) => <HostOrderRow host={host} />}
        />
      </Animated.ScrollView>
    </View>
  )
}

function HostOrderRow({ host }: { host: HostCatalogEntry }) {
  const display = useHostDisplay(host)
  return (
    <View style={styles.row}>
      <Monitor size={20} color={colors.textSecondary} />
      <View style={styles.label}>
        <Text style={styles.name} numberOfLines={1}>
          {display.title}
        </Text>
        {display.descriptorLine ? (
          <Text style={styles.descriptor} numberOfLines={1}>
            {display.descriptorLine}
          </Text>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: spacing.sm
  },
  title: { color: colors.textPrimary, fontSize: 18, fontWeight: '600' },
  done: { color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  hint: { color: colors.textMuted, fontSize: 12, paddingBottom: spacing.md },
  scroll: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    gap: spacing.md
  },
  label: { flex: 1, minWidth: 0 },
  name: { color: colors.textPrimary, fontSize: 15, fontWeight: '500' },
  descriptor: { color: colors.textSecondary, fontSize: 12, marginTop: 2 }
})
