import { ChevronDown } from 'lucide-react-native'
import { useState, type ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { PickerModal } from '../../components/PickerModal'
import { statusDotColor } from '../../components/StatusDot'
import { hostPickerOptions, useHostPickerSearch } from '../../components/use-connected-host-picker'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { HostProfile } from '../../host-catalog/host-profile'
import { useHostDisplay } from '../../host-descriptors/use-host-display'

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
  const title = useHostDisplay(props.host).title
  const choosable = props.hosts.length > 1
  const hostSearch = useHostPickerSearch(props.hosts.length)
  const dot = statusDotColor(props.state ?? 'disconnected')
  return (
    <>
      <MobileHomePill
        label={title}
        leading={<View style={[styles.dot, { backgroundColor: dot }]} />}
        accessibilityLabel={
          choosable
            ? t('home.tabs.chooseDesktop', '{{desktop}}, choose another desktop', {
                desktop: title
              })
            : title
        }
        onPress={choosable ? () => setOpen(true) : undefined}
      />
      {choosable ? (
        <PickerModal
          visible={open}
          title={props.pickerTitle}
          options={hostPickerOptions([...props.hosts])}
          selected={props.host.id}
          onSelect={props.onPick}
          onClose={() => setOpen(false)}
          {...hostSearch}
        />
      ) : null}
    </>
  )
}

/** A Home tab's filter pill; without `onPress` it is a plain label. */
export function MobileHomePill(props: {
  label: string
  leading: ReactNode
  accessibilityLabel: string
  onPress?: () => void
}) {
  useMobileColorScheme()
  const [pressed, setPressed] = useState(false)
  const choosable = props.onPress !== undefined
  return (
    <Pressable
      accessibilityRole={choosable ? 'button' : 'text'}
      accessibilityLabel={props.accessibilityLabel}
      disabled={!choosable}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={props.onPress}
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
        {props.leading}
        <Text style={styles.label} numberOfLines={1}>
          {props.label}
        </Text>
        {choosable ? <ChevronDown size={14} color={colors.textSecondary} /> : null}
      </Animated.View>
    </Pressable>
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
