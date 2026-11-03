import {
  CalendarClock,
  ChartNoAxesColumn,
  Gauge,
  History,
  ListTodo,
  Monitor,
  type LucideIcon
} from 'lucide-react-native'
import { useState } from 'react'
import { Text, View } from 'react-native'
import Animated, { useAnimatedRef, useSharedValue } from 'react-native-reanimated'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { DragReorderList } from '../components/DragReorderList'
import { MobileSwitch } from '../components/MobileSwitch'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { setTerminalSettingsScrollEnabled } from '../terminal/terminal-settings-scroll-lock'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import {
  canHideHomeSection,
  DEFAULT_HOME_LAYOUT,
  normalizeHomeLayout,
  type HomeLayout,
  type HomeSectionId
} from './home-layout'

// DragReorderList places rows absolutely, so every row shares one height.
const ROW_HEIGHT = 50

const SECTION_ICONS: Record<HomeSectionId, LucideIcon> = {
  jumpBackIn: History,
  desktops: Monitor,
  tasks: ListTodo,
  automations: CalendarClock,
  stats: ChartNoAxesColumn,
  accountUsage: Gauge
}

// The same words as each section's heading on Home.
function homeSectionLabel(id: HomeSectionId, t: Translate): string {
  switch (id) {
    case 'jumpBackIn':
      return t('home.jumpBackIn.heading', 'Jump back in')
    case 'desktops':
      return t('home.listHeader.desktopsHeading', 'Desktops')
    case 'tasks':
      return t('home.sections.tasks', 'Tasks')
    case 'automations':
      return t('home.listFooter.automationsHeading', 'Automations')
    case 'stats':
      return t('home.stats.heading', 'Your stats')
    case 'accountUsage':
      return t('home.accountUsage.heading', 'Account usage')
  }
}

/** "Arrange Home": drag sections into order and switch them off. Closing the sheet any way saves. */
export function MobileHomeArrangeSheet(props: {
  visible: boolean
  layout: HomeLayout
  onClose: (layout: HomeLayout) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [draft, setDraft] = useState(props.layout)
  const [openedWith, setOpenedWith] = useState<HomeLayout | null>(null)
  // Each opening starts from the saved layout, not the last session's leftovers.
  if (props.visible && openedWith !== props.layout) {
    setOpenedWith(props.layout)
    setDraft(props.layout)
  } else if (!props.visible && openedWith !== null) {
    setOpenedWith(null)
  }
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const scrollOffsetY = useSharedValue(0)
  const scrollContentHeight = useSharedValue(0)
  const close = () => props.onClose(draft)
  const toggle = (id: HomeSectionId, shown: boolean) =>
    setDraft((previous) => ({
      ...previous,
      hidden: shown
        ? previous.hidden.filter((hiddenId) => hiddenId !== id)
        : [...previous.hidden, id]
    }))

  return (
    <BottomDrawer
      visible={props.visible}
      onClose={close}
      contentScrollable={false}
      dragContentToDismiss={false}
    >
      <SheetHeader
        title={t('home.arrange.title', 'Arrange Home')}
        leading={{
          label: t('home.arrange.reset', 'Reset'),
          onPress: () => setDraft(DEFAULT_HOME_LAYOUT)
        }}
        trailing={{ label: t('home.arrange.done', 'Done'), onPress: close }}
      />
      <Animated.ScrollView
        ref={scrollRef}
        style={styles.scroll}
        bounces={false}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(event) => {
          scrollOffsetY.value = event.nativeEvent.contentOffset.y
        }}
        onContentSizeChange={(_width, height) => {
          scrollContentHeight.value = height
        }}
      >
        <View style={styles.group}>
          <DragReorderList
            items={[...draft.order]}
            itemKey={(id) => id}
            rowHeight={ROW_HEIGHT}
            scrollRef={scrollRef}
            scrollOffsetY={scrollOffsetY}
            scrollContentHeight={scrollContentHeight}
            // Imperative: a rerender mid-drag rebuilds the row gestures and drops the drag.
            onDragActiveChange={(active) => setTerminalSettingsScrollEnabled(scrollRef, !active)}
            onReorder={(order) =>
              setDraft((previous) => normalizeHomeLayout({ ...previous, order }))
            }
            renderRow={(id) => (
              <ArrangeRow
                id={id}
                label={homeSectionLabel(id, t)}
                shown={!draft.hidden.includes(id)}
                onToggle={(shown) => toggle(id, shown)}
              />
            )}
          />
        </View>
        <Text style={styles.hint}>
          {t('home.arrange.hint', 'Drag to move. Turn a section off to hide it.')}
        </Text>
      </Animated.ScrollView>
    </BottomDrawer>
  )
}

function ArrangeRow(props: {
  id: HomeSectionId
  label: string
  shown: boolean
  onToggle: (shown: boolean) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const Icon = SECTION_ICONS[props.id]
  const hideable = canHideHomeSection(props.id)
  return (
    <View style={styles.row}>
      <Icon size={18} color={colors.textSecondary} />
      <Text style={[styles.label, !props.shown && styles.labelHidden]} numberOfLines={1}>
        {props.label}
      </Text>
      <MobileSwitch
        value={props.shown}
        disabled={!hideable}
        accessibilityLabel={t('home.arrange.showSection', 'Show {{section}}', {
          section: props.label
        })}
        onValueChange={props.onToggle}
      />
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  scroll: { flexShrink: 1, minHeight: 0 },
  group: { backgroundColor: colors.sheetGroup, borderRadius: radii.surface, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    height: ROW_HEIGHT,
    paddingLeft: spacing.lg
  },
  label: { flex: 1, minWidth: 0, fontSize: 16, color: colors.textPrimary },
  labelHidden: { color: colors.textMuted },
  hint: {
    fontSize: 13,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.md,
    paddingHorizontal: spacing.xs
  }
}))
