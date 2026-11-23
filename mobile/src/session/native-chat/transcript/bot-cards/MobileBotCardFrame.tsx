import type { ReactNode } from 'react'
import { Pressable, Text, View } from 'react-native'
import { colors, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { styles as card } from '../agent-messages/mobile-agent-message-card-styles'
import { scaledType } from '../messages/mobile-native-chat-message-styles'

export const BOT_CARD_AVATAR_SIZE = 24

/** Every phone bot card: the compact chat card, a 24 pt avatar, a heading over a 14 pt title, and its
 *  body. `onToggle` makes the head fold the card open. */
export function MobileBotCardFrame({
  avatar,
  heading,
  trailing,
  title,
  meta,
  fontScale,
  onToggle,
  expanded,
  testID,
  children
}: {
  avatar: ReactNode
  heading?: string
  trailing?: ReactNode
  title: string
  meta?: ReactNode
  fontScale: number
  onToggle?: () => void
  expanded?: boolean
  testID?: string
  children?: ReactNode
}): React.JSX.Element {
  useMobileColorScheme()
  const head = (
    <View style={styles.head}>
      <View style={styles.avatar}>{avatar}</View>
      <View style={styles.text}>
        {heading || trailing ? (
          <View style={styles.headingLine}>
            {heading ? (
              <Text
                numberOfLines={1}
                style={[styles.heading, scaledType(typography.metaSize, fontScale, 4)]}
              >
                {heading}
              </Text>
            ) : null}
            {trailing}
          </View>
        ) : null}
        <Text
          numberOfLines={1}
          style={[styles.title, scaledType(typography.bodySize, fontScale, 4)]}
        >
          {title}
        </Text>
        {meta}
      </View>
    </View>
  )
  return (
    <View style={card.compactCard} testID={testID}>
      {onToggle ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: expanded === true }}
          onPress={onToggle}
          style={styles.toggle}
        >
          {head}
        </Pressable>
      ) : (
        head
      )}
      {children ? <View style={styles.body}>{children}</View> : null}
    </View>
  )
}

/** A card's meta line under its title, 12 pt. */
export function MobileBotCardMeta({
  children,
  fontScale,
  lines = 1
}: {
  children: ReactNode
  fontScale: number
  lines?: number
}): React.JSX.Element {
  return (
    <Text
      numberOfLines={lines}
      style={[styles.meta, scaledType(typography.metaSize, fontScale, 4)]}
    >
      {children}
    </Text>
  )
}

/** The card's left-aligned row of pills. */
export function MobileBotCardActions({ children }: { children: ReactNode }): React.JSX.Element {
  return <View style={styles.actions}>{children}</View>
}

const styles = themedStyleSheet(() => ({
  toggle: { borderRadius: radii.surface },
  head: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 44
  },
  avatar: {
    width: BOT_CARD_AVATAR_SIZE,
    height: BOT_CARD_AVATAR_SIZE,
    borderRadius: BOT_CARD_AVATAR_SIZE / 4,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised,
    marginTop: 2
  },
  text: { flex: 1, minWidth: 0, gap: 1 },
  headingLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  heading: { flexShrink: 1, color: colors.textMuted },
  title: { color: colors.textPrimary, fontWeight: '600' },
  meta: { color: colors.textMuted },
  body: { paddingHorizontal: spacing.md, paddingBottom: spacing.sm, gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm }
}))
