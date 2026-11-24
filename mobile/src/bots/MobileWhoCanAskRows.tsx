// Who can ask's rows: each person with their face, and each row's actions in its menu and behind a
// swipe, so no row carries loose text buttons.
import { useRef, useState, type ReactNode } from 'react'
import { Image, View, type HostInstance } from 'react-native'
import type { LucideIcon } from 'lucide-react-native'
import {
  Bot,
  Eye,
  Server,
  ServerOff,
  UserMinus,
  UserPlus,
  UserRound,
  X
} from '../components/icons/app-icons'
import type { BotMember } from '../../../src/shared/bot-types'
import { botMemberAvatarUrl } from '../../../src/shared/bots/bot-member-avatar-url'
import { connectorAskerInitials } from '../../../src/shared/connectors/connector-message-asker-view'
import { accessRequestPerson } from '../../../src/shared/bots/bot-access-request'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import { LIST_ROW_PADDING, ListRow } from '../components/list/ListGroup'
import { SwipeRowActions } from '../components/list/SwipeRowActions'
import { PullDownMenu } from '../components/nav-bar/PullDownMenu'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { triggerMediumImpact } from '../platform/haptics/haptics'
import { PrCommentAvatar } from '../source-control/review/pull-request/comments/PrCommentAvatar'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { accessRequestGrant, accessRequestLine } from './bot-access-request-copy'
import { MobileBotAccessDecisionContent } from './MobileBotAccessDecision'
import { SettingsSection } from '../settings/settings-screen-frame'
import { mobileBotAccessCopy } from './mobile-bot-access-copy'

// The phone's person face, as pull request threads and group members draw it.
const FACE = 28
/** Where hairlines start in a group of faces, under the names. */
export const WHO_FACE_INSET = LIST_ROW_PADDING + FACE + spacing.md

/** How a person or app reads here: Slack names its apps "… (app)", which the app's mark already says. */
export function whoCanAskName(member: Pick<BotMember, 'id' | 'name' | 'kind'>): string {
  const name = member.name || member.id
  return member.kind === 'app' ? name.replace(/\s*\(app\)$/i, '') || name : name
}

/** A picture, else initials on the person's tint; an app or the owner, a mark on a grey disc. */
export function MobilePersonFace(props: {
  id: string
  name: string
  picture?: string
  mark?: LucideIcon
}) {
  useMobileColorScheme()
  const [failed, setFailed] = useState<string | null>(null)
  if (props.mark) {
    const Mark = props.mark
    return (
      <View style={styles.disc}>
        <Mark size={15} color={colors.textSecondary} strokeWidth={2.2} />
      </View>
    )
  }
  return (
    <View style={styles.face}>
      <PrCommentAvatar login={props.id} label={connectorAskerInitials(props.name)} size={FACE} />
      {props.picture && failed !== props.picture ? (
        <Image
          source={{ uri: props.picture }}
          style={styles.picture}
          onError={() => setFailed(props.picture ?? null)}
          accessibilityIgnoresInvertColors
        />
      ) : null}
    </View>
  )
}

/** A person's face, or an app's mark. */
export function MobileWhoCanAskMemberFace({ member }: { member: BotMember }) {
  return (
    <MobilePersonFace
      id={member.id}
      name={whoCanAskName(member)}
      picture={botMemberAvatarUrl(member) ?? undefined}
      mark={member.kind === 'app' ? Bot : undefined}
    />
  )
}

/** The "You" row's face, on a connector's own page. */
export function MobileWhoCanAskOwnerFace() {
  return <MobilePersonFace id="" name="" mark={UserRound} />
}

type RowAction = {
  label: string
  accessibilityLabel: string
  icon: LucideIcon
  destructive?: boolean
  onPress: () => void
}

/**
 * A row whose actions sit in a menu and behind a left swipe (the last action). A tap opens the menu,
 * or runs `onPress` when the row has a main action, and then a long press opens it.
 */
function RowWithActions(props: {
  actions: readonly RowAction[]
  onPress?: () => void
  busy: boolean
  children: (press: { onPress: () => void; onLongPress: () => void }) => ReactNode
}) {
  const anchor = useRef<HostInstance>(null)
  const [open, setOpen] = useState(false)
  // Mounted from the first open, and kept so its close fade plays: a long list mounts no menus.
  const [opened, setOpened] = useState(false)
  const swiped = props.actions.at(-1)
  const openMenu = () => {
    triggerMediumImpact()
    setOpened(true)
    setOpen(true)
  }
  return (
    <View ref={anchor} collapsable={false}>
      <SwipeRowActions
        enabled={!props.busy}
        trailing={
          swiped && {
            label: swiped.label,
            accessibilityLabel: swiped.accessibilityLabel,
            icon: swiped.icon,
            background: swiped.destructive ? colors.statusRed : colors.textMuted,
            foreground: swiped.destructive ? colors.onStatusRed : colors.onAccent,
            onPress: swiped.onPress
          }
        }
      >
        {(guardPress) =>
          props.children({
            onPress: guardPress(props.onPress ?? openMenu),
            onLongPress: openMenu
          })
        }
      </SwipeRowActions>
      {opened ? (
        <PullDownMenu
          visible={open}
          anchorRef={anchor}
          groups={[
            props.actions.map((action) => ({
              label: action.label,
              icon: action.icon,
              destructive: action.destructive,
              // The host can go offline while the menu is open.
              disabled: props.busy,
              closeBeforePress: true,
              onPress: action.onPress
            }))
          ]}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  )
}

/** One person or app who can ask; Remove is in its menu and behind a swipe. */
export function MobileWhoCanAskPersonRow(props: {
  member: BotMember
  busy: boolean
  onRemove: () => void
}) {
  const t = useMobileTranslation()
  const { member } = props
  const name = whoCanAskName(member)
  return (
    <RowWithActions
      busy={props.busy}
      actions={[
        {
          label: t('bots.settings.remove', 'Remove'),
          accessibilityLabel: t('bots.settings.removeName', 'Remove {{name}}', { name }),
          icon: UserMinus,
          destructive: true,
          onPress: props.onRemove
        }
      ]}
    >
      {(press) => (
        <ListRow
          {...press}
          leading={<MobileWhoCanAskMemberFace member={member} />}
          title={name}
          busy={props.busy}
        />
      )}
    </RowWithActions>
  )
}

/** A paired server always allowed to ask; Remove is in its menu and behind a swipe. */
export function MobileWhoCanAskServerRow(props: {
  name: string
  busy: boolean
  onRemove: () => void
}) {
  const t = useMobileTranslation()
  return (
    <RowWithActions
      busy={props.busy}
      actions={[
        {
          label: t('bots.pairedServers.remove', 'Remove'),
          accessibilityLabel: t('bots.pairedServers.removeServer', 'Remove {{server}}', {
            server: props.name
          }),
          icon: ServerOff,
          destructive: true,
          onPress: props.onRemove
        }
      ]}
    >
      {(press) => (
        <ListRow
          {...press}
          leading={
            <MobileFaceSlot>
              <Server size={20} color={colors.textSecondary} />
            </MobileFaceSlot>
          }
          title={props.name}
          busy={props.busy}
        />
      )}
    </RowWithActions>
  )
}

/** Someone asking for access: a tap reviews it; Decline is in its menu and behind a swipe. */
export function MobileWhoCanAskRequestRow(props: {
  request: ConnectorAccessRequest
  busy: boolean
  onReview: () => void
  onDecline: () => void
}) {
  const t = useMobileTranslation()
  const { request } = props
  const person = accessRequestPerson(request)
  const review = {
    label: mobileBotAccessCopy(t, 'review'),
    accessibilityLabel: t('bots.settings.reviewName', 'Review {{name}}', { name: person }),
    icon: Eye,
    onPress: props.onReview
  }
  return (
    <RowWithActions
      busy={props.busy}
      onPress={props.onReview}
      actions={[
        review,
        {
          label: mobileBotAccessCopy(t, 'decline'),
          accessibilityLabel: t('bots.settings.declineName', 'Decline {{name}}', { name: person }),
          icon: X,
          onPress: props.onDecline
        }
      ]}
    >
      {(press) => (
        <ListRow
          {...press}
          leading={
            <MobilePersonFace
              id={request.requester.id}
              name={person}
              picture={request.requester.avatarUrl ?? undefined}
            />
          }
          title={person}
          subtitle={accessRequestLine(request, t)}
          subtitleLines={1}
          navigates
          busy={props.busy}
          accessibilityLabel={`${review.accessibilityLabel}, ${accessRequestLine(request, t)}`}
        />
      )}
    </RowWithActions>
  )
}

/** Review a request: the Give access confirm, with Cancel to back out, then Decline as the page's one
 *  red row, so declining needs no swipe or long press. */
export function MobileWhoCanAskReview(props: {
  request: ConnectorAccessRequest
  bot: Parameters<typeof MobileBotAccessDecisionContent>[0]['bot']
  busy: boolean
  onDecide: (decision: 'granted' | 'declined') => void
  onClose: () => void
}) {
  const t = useMobileTranslation()
  return (
    <>
      <MobileBotAccessDecisionContent
        grant={accessRequestGrant(props.request)}
        bot={props.bot}
        onGrant={() => props.onDecide('granted')}
        onClose={props.onClose}
      />
      <SettingsSection>
        <ListRow
          title={mobileBotAccessCopy(t, 'decline')}
          destructive
          disabled={props.busy}
          onPress={() => {
            props.onDecide('declined')
            props.onClose()
          }}
        />
      </SettingsSection>
    </>
  )
}

/** An icon in a face's place, centred under the faces so the titles line up. */
export function MobileFaceSlot({ children }: { children: ReactNode }) {
  return <View style={styles.slot}>{children}</View>
}

/** Add people, its icon in a face's place. */
export function MobileWhoCanAskAddRow(props: { disabled: boolean; onPress: () => void }) {
  const t = useMobileTranslation()
  return (
    <ListRow
      leading={
        <MobileFaceSlot>
          <UserPlus size={20} color={colors.textPrimary} />
        </MobileFaceSlot>
      }
      title={t('bots.whoCanAsk.addPeople', 'Add people')}
      disabled={props.disabled}
      onPress={props.onPress}
    />
  )
}

const styles = themedStyleSheet(() => ({
  face: { width: FACE, height: FACE },
  picture: {
    position: 'absolute',
    width: FACE,
    height: FACE,
    borderRadius: radii.pill
  },
  disc: {
    width: FACE,
    height: FACE,
    borderRadius: radii.pill,
    backgroundColor: colors.translucentFill,
    alignItems: 'center',
    justifyContent: 'center'
  },
  slot: { width: FACE, alignItems: 'center' }
}))
