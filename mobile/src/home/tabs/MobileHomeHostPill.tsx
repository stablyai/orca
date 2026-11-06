import { ChevronDown } from 'lucide-react-native'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { PickerModal } from '../../components/PickerModal'
import { statusDotColor } from '../../components/StatusDot'
import { hostPickerOptions } from '../../components/use-connected-host-picker'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { ConnectionState, HostProfile } from '../../transport/types'
import { useHostDisplay } from '../../transport/use-host-display'

/** The desktop a per-desktop tab shows; it stays put until the user picks another or it is unpaired. */
export function useHomeTabHost(hosts: readonly HostProfile[], preferred: readonly HostProfile[]) {
  const [picked, setPicked] = useState<string | null>(null)
  const host =
    hosts.find((candidate) => candidate.id === picked) ?? preferred[0] ?? hosts[0] ?? null
  return { host, pick: setPicked }
}

/**
 * Names the desktop a tab is showing. With one desktop it is a plain label; with more it opens
 * a picker sheet titled `pickerTitle`.
 */
export function MobileHomeHostPill(props: {
  hosts: readonly HostProfile[]
  host: HostProfile
  state: ConnectionState | undefined
  pickerTitle: string
  onPick: (hostId: string) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [open, setOpen] = useState(false)
  const [pressed, setPressed] = useState(false)
  const title = useHostDisplay(props.host).title
  const choosable = props.hosts.length > 1
  const dot = statusDotColor(props.state ?? 'disconnected')
  return (
    <>
      <Pressable
        accessibilityRole={choosable ? 'button' : 'text'}
        accessibilityLabel={
          choosable
            ? t('home.tabs.chooseDesktop', '{{desktop}}, choose another desktop', {
                desktop: title
              })
            : title
        }
        disabled={!choosable}
        onPressIn={() => setPressed(true)}
        onPressOut={() => setPressed(false)}
        onPress={() => setOpen(true)}
        style={styles.pillHit}
      >
        <Animated.View
          style={[
            styles.pill,
            pressed && styles.pillPressed,
            {
              transform: [{ scale: pressed ? 0.97 : 1 }],
              transitionProperty: ['transform', 'backgroundColor'],
              transitionDuration: 120
            }
          ]}
        >
          <View style={[styles.dot, { backgroundColor: dot }]} />
          <Text style={styles.label} numberOfLines={1}>
            {title}
          </Text>
          {choosable ? <ChevronDown size={14} color={colors.textSecondary} /> : null}
        </Animated.View>
      </Pressable>
      {choosable ? (
        <PickerModal
          visible={open}
          title={props.pickerTitle}
          options={hostPickerOptions([...props.hosts])}
          selected={props.host.id}
          onSelect={props.onPick}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  )
}

const styles = themedStyleSheet(() => ({
  pillHit: { alignSelf: 'flex-start', maxWidth: '100%' },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    minHeight: 32,
    paddingLeft: spacing.md,
    paddingRight: 10,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    marginLeft: 2,
    borderRadius: radii.pill,
    backgroundColor: colors.bgPanel
  },
  pillPressed: { backgroundColor: colors.bgRaised },
  dot: { width: 7, height: 7, borderRadius: radii.pill },
  label: { flexShrink: 1, fontSize: 14, color: colors.textSecondary }
}))
