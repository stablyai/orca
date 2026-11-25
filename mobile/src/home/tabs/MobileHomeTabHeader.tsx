import type { AppIcon } from '../../components/icons/app-icons'
import { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { colors, radii, spacing } from '../../theme/mobile-theme'
import { themedStyleSheet } from '../../theme/themed-styles'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { NativeMenu } from '../../components/menu/NativeMenu'
import { isMenuAction } from '../../components/nav-bar/screen-header-props'
import type { HomeTabHeaderProps } from './home-tab-header-props'

/** A Home tab's drawn title row: the tab's name and at most two icon buttons. */
export function MobileHomeTabHeader(props: HomeTabHeaderProps) {
  useMobileColorScheme()
  return (
    <View style={styles.bar}>
      <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
        {props.title}
      </Text>
      {props.actions.length > 0 ? (
        <View style={styles.actions}>
          {props.actions.map((action) =>
            isMenuAction(action) ? (
              <NativeMenu key={action.id} groups={action.menu}>
                {(openMenu) => (
                  <MobileHomeTabHeaderButton
                    icon={action.icon}
                    accessibilityLabel={action.label}
                    onPress={openMenu}
                  />
                )}
              </NativeMenu>
            ) : (
              <MobileHomeTabHeaderButton
                key={action.id}
                icon={action.icon}
                accessibilityLabel={action.label}
                disabled={action.disabled}
                spinning={action.spinning}
                active={action.active}
                onPress={action.onPress}
              />
            )
          )}
        </View>
      ) : null}
    </View>
  )
}

function MobileHomeTabHeaderButton(props: {
  icon: AppIcon
  accessibilityLabel: string
  disabled?: boolean
  /** Spins the glyph while a refresh it started is in flight. */
  spinning?: boolean
  /** What the button opens is showing. */
  active?: boolean
  onPress: () => void
}) {
  useMobileColorScheme()
  const [pressed, setPressed] = useState(false)
  const Icon = props.icon
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      accessibilityState={{
        disabled: Boolean(props.disabled),
        busy: Boolean(props.spinning),
        expanded: props.active
      }}
      disabled={props.disabled}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      onPress={props.onPress}
      style={[
        styles.button,
        (pressed || props.active) && styles.buttonPressed,
        props.disabled && styles.disabled
      ]}
    >
      <Animated.View
        style={
          props.spinning
            ? {
                animationName: {
                  from: { transform: [{ rotate: '0deg' }] },
                  to: { transform: [{ rotate: '360deg' }] }
                },
                animationDuration: 900,
                animationIterationCount: 'infinite',
                animationTimingFunction: 'linear'
              }
            : null
        }
      >
        <Icon size={21} color={colors.textSecondary} />
      </Animated.View>
    </Pressable>
  )
}

const styles = themedStyleSheet(() => ({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingLeft: spacing.lg + spacing.xs,
    paddingRight: spacing.sm
  },
  title: {
    flexShrink: 1,
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: -0.4,
    color: colors.textPrimary
  },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  button: {
    width: 44,
    height: 44,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center'
  },
  buttonPressed: { backgroundColor: colors.bgRaised },
  disabled: { opacity: 0.4 }
}))
