// The desktop's marks on a person's message: for one Orca delivered from Slack, GitHub, Linear or
// Discord, the "Sam Lee · Slack" tag and the folded lines from people without access; for one another
// person typed on their paired computer, "Sam Lee · Sam's MacBook Pro"; "Sent as goal".
import { useState } from 'react'
import { Pressable, Text, View, type StyleProp, type TextStyle } from 'react-native'
import { ChevronRight, Goal } from '../../../../components/icons/app-icons'
import type { ConnectorMessageAsker } from '../../../../../../src/shared/connector-message-asker'
import type { NativeChatMessage } from '../../../../../../src/shared/native-chat/native-chat-types'
import {
  connectorAskerInitials,
  connectorAskerTagView,
  connectorNoAccessView
} from '../../../../../../src/shared/connectors/connector-message-asker-view'
import { MobileConnectorSourceIcon } from '../../../../bots/MobileConnectorSourceIcon'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { openExternalLink } from '../../../../platform/external-links/external-link'
import { colors, pressedStyle, radii, spacing, typography } from '../../../../theme/mobile-theme'
import { themedStyleSheet } from '../../../../theme/themed-styles'
import { MobileNativeChatAutomationResultsCarried } from '../MobileNativeChatBotRowNotes'
import { useMobileColorScheme } from '../../../../theme/use-mobile-color-scheme'
import { MobileSlackMirrorPostLine } from '../../slack-mirror/MobileSlackMirrorPost'
import { useMobileSlackMirrorContext } from '../../slack-mirror/use-mobile-slack-mirror'
import { slackMirrorPostedAsker } from '../../../../../../src/shared/connectors/slack-mirror-state'
import {
  otherPersonTypistWords,
  type OtherPersonTypist
} from '../../../../../../src/shared/agent-session/journal/agent-journal-typed-by'

const ICON_SIZE = 12

// The phone has no avatar cache, so a person shows by initials, as the desktop does when it can't load one.
function Initials({ name }: { name: string }): React.JSX.Element {
  return (
    <View style={styles.initials}>
      <Text style={styles.initialsText}>{connectorAskerInitials(name)}</Text>
    </View>
  )
}

export function MobileNativeChatConnectorAskerTag({
  asker,
  nameless = false
}: {
  asker: ConnectorMessageAsker
  /** Only the place: a sender tag beside it already names who typed it. */
  nameless?: boolean
}): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const view = connectorAskerTagView(asker, t)
  const { own, name, place, open } = view
  // Spoken like it reads: a nameless tag never credits the synthetic owner ("You in Slack").
  const label = nameless ? place : view.label
  const content = (
    <>
      {own || nameless ? null : <Initials name={name} />}
      {nameless ? null : (
        <>
          <Text numberOfLines={1} style={[styles.tagText, styles.name]}>
            {name}
          </Text>
          <Text style={styles.tagText}>·</Text>
        </>
      )}
      <MobileConnectorSourceIcon source={asker.source} size={ICON_SIZE} />
      <Text numberOfLines={1} style={[styles.tagText, styles.shrink]}>
        {place}
      </Text>
    </>
  )
  if (!open) {
    return (
      <View style={styles.tag} accessible accessibilityLabel={label}>
        {content}
      </View>
    )
  }
  return (
    <Pressable
      style={({ pressed }) => [styles.tag, pressed && pressedStyle]}
      accessibilityRole="link"
      accessibilityLabel={`${label}. ${open.label}`}
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() => openExternalLink(open.url)}
    >
      {content}
    </Pressable>
  )
}

/** "Sam Lee · Sam's MacBook Pro"; the phone has no tooltip, so it speaks the full line. */
function MobileNativeChatTypedByTag({ typist }: { typist: OtherPersonTypist }): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { name, computer, label } = otherPersonTypistWords(typist, t)
  return (
    <View style={[styles.tag, styles.typistTag]} accessible accessibilityLabel={label}>
      <Text numberOfLines={1} style={[styles.tagText, styles.name]}>
        {name}
      </Text>
      <Text style={styles.tagText}>·</Text>
      <Text numberOfLines={1} style={[styles.tagText, styles.shrink]}>
        {computer}
      </Text>
    </View>
  )
}

/** A person's own Orca-typed message: who typed it when another person did, and once it is in the
 *  chat's Slack thread the "You · Slack" tag (just "Slack" beside another person's name). */
function MobileTypedMessageTags({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element | null {
  const mirror = useMobileSlackMirrorContext()
  const posted = mirror?.link.mirrorPosts?.[message.id]?.state === 'posted'
  const typist = message.typedByOther
  if (!posted && !typist) {
    return null
  }
  return (
    <View style={[styles.marks, styles.marksEnd, styles.marksFull]}>
      <View style={styles.tagRow}>
        {typist ? <MobileNativeChatTypedByTag typist={typist} /> : null}
        {posted && mirror ? (
          <MobileNativeChatConnectorAskerTag
            asker={slackMirrorPostedAsker(mirror.link)}
            nameless={typist !== undefined}
          />
        ) : null}
      </View>
    </View>
  )
}

/** The queued card's "From Sam Lee · Sam's MacBook Pro", where the owner's own card reads "You". */
export function MobileQueuedTypedByLine({
  typist,
  textStyle
}: {
  typist: OtherPersonTypist
  textStyle: StyleProp<TextStyle>
}): React.JSX.Element {
  const t = useMobileTranslation()
  const { name, computer, label } = otherPersonTypistWords(typist, t)
  return (
    <View style={styles.queuedTypist} accessible accessibilityLabel={label}>
      <Text style={[textStyle, styles.fixed]}>
        {t('session.agentMessageAttribution.fromSender', 'From')}
      </Text>
      <Text numberOfLines={1} style={[textStyle, styles.queuedTypistName]}>
        {name}
      </Text>
      <Text style={[textStyle, styles.fixed]}>·</Text>
      <Text numberOfLines={1} style={[textStyle, styles.queuedTypistComputer]}>
        {computer}
      </Text>
    </View>
  )
}

/** The tag (not on another agent's card, which names its own sender) and any no-access lines. */
export function MobileNativeChatConnectorMarks({
  message,
  tagged,
  end
}: {
  message: NativeChatMessage
  tagged: boolean
  /** Aligned to the person's bubble. */
  end: boolean
}): React.JSX.Element | null {
  const { asker } = message
  if (!asker) {
    return tagged && end ? <MobileTypedMessageTags message={message} /> : null
  }
  return (
    <View style={[styles.marks, end && styles.marksEnd]}>
      {tagged ? <MobileNativeChatConnectorAskerTag asker={asker} /> : null}
      {asker.noAccess ? <MobileNativeChatConnectorNoAccessNote asker={asker} /> : null}
    </View>
  )
}

/** Under the person's bubble, as on desktop: its Slack post's line, "Sent as goal", then the
 *  automation results it carried. */
export function MobileNativeChatUserMessageNotes({
  message
}: {
  message: NativeChatMessage
}): React.JSX.Element {
  return (
    <>
      <MobileSlackMirrorPostLine messageId={message.id} />
      {message.sentAs === 'goal' ? <MobileNativeChatSentAsGoal /> : null}
      {message.automationResultsCarried ? (
        <MobileNativeChatAutomationResultsCarried count={message.automationResultsCarried} />
      ) : null}
    </>
  )
}

export function MobileNativeChatSentAsGoal(): React.JSX.Element {
  useMobileColorScheme()
  const t = useMobileTranslation()
  return (
    <View style={styles.sentAsGoal}>
      <Goal size={ICON_SIZE} color={colors.textMuted} strokeWidth={2} />
      <Text style={styles.toggleText}>
        {t('components.native-chat.goal.sentAsGoal', 'Sent as goal')}
      </Text>
    </View>
  )
}

/** Collapsed under one note, each line muted and marked, so they read as context, never a request. */
export function MobileNativeChatConnectorNoAccessNote({
  asker
}: {
  asker: ConnectorMessageAsker
}): React.JSX.Element | null {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [open, setOpen] = useState(false)
  const view = connectorNoAccessView(asker, t)
  if (!view) {
    return null
  }
  return (
    <View style={styles.noAccess}>
      <Pressable
        style={({ pressed }) => [styles.toggle, pressed && pressedStyle]}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        hitSlop={{ top: 8, bottom: 8 }}
        onPress={() => setOpen(!open)}
      >
        <Text style={styles.toggleText}>{view.toggle}</Text>
        <ChevronRight
          size={ICON_SIZE}
          color={colors.textMuted}
          strokeWidth={2}
          style={open ? styles.chevronOpen : undefined}
        />
      </Pressable>
      {open
        ? view.lines.map((line) => (
            <View key={line.key} style={styles.noAccessLine}>
              <View
                style={[styles.tag, styles.contextTag]}
                accessible
                accessibilityLabel={line.title}
              >
                <Initials name={line.name} />
                <Text numberOfLines={1} style={[styles.tagText, styles.shrink]}>
                  {line.name}
                </Text>
                <Text style={styles.tagText}>·</Text>
                <MobileConnectorSourceIcon source={asker.source} size={ICON_SIZE} />
                <Text style={styles.tagText}>{view.sourceName}</Text>
                <Text style={styles.tagText}>·</Text>
                <Text style={styles.tagText}>{view.noAccessLabel}</Text>
              </View>
              <Text selectable style={styles.noAccessText}>
                {line.text}
              </Text>
            </View>
          ))
        : null}
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  marks: {
    alignItems: 'flex-start',
    gap: spacing.xs,
    marginBottom: spacing.xs
  },
  marksEnd: {
    alignItems: 'flex-end'
  },
  sentAsGoal: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.xs
  },
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    maxWidth: '100%',
    height: 22,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.pill,
    borderWidth: 1,
    borderColor: colors.chatUserBorder
  },
  contextTag: {
    borderStyle: 'dashed'
  },
  tagText: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  name: {
    flexShrink: 1,
    fontWeight: '500',
    color: colors.textSecondary
  },
  shrink: {
    flexShrink: 1
  },
  fixed: {
    flexShrink: 0
  },
  marksFull: {
    alignSelf: 'stretch'
  },
  typistTag: {
    flexShrink: 1,
    minWidth: 0
  },
  tagRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    maxWidth: '100%'
  },
  // Takes only the room the row's "Queued" lead leaves; the computer gives way before the name.
  queuedTypist: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0
  },
  queuedTypistName: {
    color: colors.textPrimary,
    flexShrink: 1
  },
  queuedTypistComputer: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: 0
  },
  initials: {
    width: 16,
    height: 16,
    marginLeft: -spacing.xs,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgRaised
  },
  initialsText: {
    color: colors.textMuted,
    fontSize: 9,
    fontWeight: '500'
  },
  noAccess: {
    maxWidth: '88%',
    alignItems: 'flex-end',
    gap: spacing.sm
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs
  },
  toggleText: {
    color: colors.textMuted,
    fontSize: typography.metaSize
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }]
  },
  noAccessLine: {
    maxWidth: '100%',
    alignItems: 'flex-end',
    gap: spacing.xxs
  },
  noAccessText: {
    color: colors.textMuted,
    fontSize: typography.bodySize,
    borderRightWidth: 2,
    borderRightColor: colors.borderSubtle,
    paddingRight: spacing.sm
  }
}))
