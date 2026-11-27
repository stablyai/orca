// The desktop's "Give access" confirm on the phone: who would get access and where, the warning in its
// tone, and what they would reach. As a sheet, Decline answers here too; closing any other way leaves the request
// waiting.
import { useEffect, useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Laptop, Mail, ShieldAlert, ShieldOff, type LucideIcon } from 'lucide-react-native'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { LIST_LEADING_INSET, ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import { intlLocaleFor } from '../i18n/ui-intl-locale'
import { useMobileTranslation, useMobileUiLocale } from '../i18n/use-mobile-translation'
import type { BotPanelOpen } from './MobileBotPanel'
import {
  accessDecisionCopy,
  accessRequestExpiredLine,
  accessRequestGrant,
  phoneAccessHost,
  type AccessDecisionRow,
  type PhoneAccessBot,
  type PhoneAccessGrant
} from './bot-access-request-copy'
import { readConnectionStatusProbe } from '../transport/connection/runtime-status-probe'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { BotAccessRequests } from './use-bot-access-requests'
import { MobileConnectorSourceIcon } from './MobileConnectorSourceIcon'
import { mobileBotAccessCopy } from './mobile-bot-access-copy'
import { SettingsNote } from '../settings/settings-screen-frame'

const ROW_ICONS: Partial<Record<AccessDecisionRow['kind'], LucideIcon>> = {
  computer: Laptop,
  'no-approvals': ShieldOff,
  'may-skip-approvals': ShieldAlert,
  approves: ShieldAlert,
  google: Mail
}

function RowIcon({ row }: { row: AccessDecisionRow }) {
  const colors = useMobileColors()
  if (row.connector) {
    return <MobileConnectorSourceIcon source={row.connector} size={16} />
  }
  const Icon = ROW_ICONS[row.kind] ?? ShieldAlert
  return (
    <Icon size={17} strokeWidth={2} color={row.warn ? colors.statusRed : colors.textSecondary} />
  )
}

export function MobileBotAccessDecisionContent({
  grant,
  bot,
  onGrant,
  onDecline,
  onClose
}: {
  grant: PhoneAccessGrant
  bot: PhoneAccessBot
  onGrant: () => void
  /** Decline in place of Cancel, where nothing else beside the confirm declines. */
  onDecline?: () => void
  onClose: () => void
}) {
  const colors = useMobileColors()
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const copy = accessDecisionCopy(grant, bot, t, intlLocaleFor(useMobileUiLocale()))
  const tone = copy.tone === 'high' ? colors.statusRed : colors.statusAmber
  return (
    <ConfirmContent
      media={
        <View style={styles.tile}>
          <View style={[styles.tileWash, { backgroundColor: tone }]} />
          <ShieldAlert size={24} strokeWidth={2} color={tone} />
        </View>
      }
      title={copy.title}
      message={copy.who}
      details={
        <>
          <Text style={styles.warning}>{copy.warning}</Text>
          <SectionHeader title={copy.whatTheyCanDo} first />
          <ListGroup separatorInset={LIST_LEADING_INSET}>
            {copy.rows.map((row) => (
              <ListRow key={row.kind} title={row.text} leading={<RowIcon row={row} />} />
            ))}
          </ListGroup>
          <SettingsNote>{mobileBotAccessCopy(t, 'removeAnyTime')}</SettingsNote>
        </>
      }
      {...(onDecline
        ? { cancelLabel: mobileBotAccessCopy(t, 'decline'), onCancelPress: onDecline }
        : {})}
      confirmLabel={mobileBotAccessCopy(t, 'confirm')}
      destructive
      onConfirm={onGrant}
      onCancel={onClose}
    />
  )
}

/** The decision as a sheet of its own, over whatever opened it, with Decline beside Give access;
 *  `review` opens it on a request. Null without the bot's requests. */
export function useBotAccessDecisionSheet(
  {
    accessRequests: access,
    client,
    open
  }: {
    accessRequests: BotAccessRequests | null
    client: RpcClient | null
    /** What the panel opened on: an access request, from its push, opens here once read. */
    open: BotPanelOpen | null
  },
  bot: Omit<PhoneAccessBot, 'accessHost'>,
  showToast: (message: string) => void
): { review: (request: ConnectorAccessRequest) => void; sheet: ReactNode } {
  const t = useMobileTranslation()
  const [reviewing, setReviewing] = useState<ConnectorAccessRequest | null>(null)
  // An access open waits for a read that landed after it, so a request newer than the last read is found.
  const [asked, setAsked] = useState<{ open: BotPanelOpen; after: number } | null>(null)
  // The open whose request was gone by the time its read landed.
  const [missing, setMissing] = useState<BotPanelOpen | null>(null)
  if (open && 'access' in open && asked?.open !== open) {
    setAsked({ open, after: access?.reads ?? 0 })
  } else if (asked && asked.open !== open) {
    // Closed or moved on before its read landed: a later open isn't this push's.
    setAsked(null)
  } else if (asked && 'access' in asked.open && access && access.reads > asked.after) {
    const id = asked.open.access
    setAsked({ open: asked.open, after: Number.POSITIVE_INFINITY })
    const request = access.requests.find((entry) => entry.requestId === id)
    if (request) {
      setReviewing(request)
    } else {
      setMissing(asked.open)
    }
  }
  useEffect(() => {
    if (missing) {
      showToast(accessRequestExpiredLine(t))
    }
  }, [missing, showToast, t])
  // Answered elsewhere, or no longer read: nothing is left to decide.
  if (reviewing && !access?.requests.some((request) => request.requestId === reviewing.requestId)) {
    setReviewing(null)
  }
  // The last request stays drawn while the sheet slides away.
  const [shown, setShown] = useState(reviewing)
  if (reviewing !== null && reviewing !== shown) {
    setShown(reviewing)
  }
  const close = () => setReviewing(null)
  const sheet = access ? (
    <BottomDrawer visible={reviewing !== null} onClose={close}>
      {shown ? (
        <MobileBotAccessDecisionContent
          grant={accessRequestGrant(shown)}
          bot={{
            ...bot,
            accessHost: phoneAccessHost(client ? readConnectionStatusProbe(client) : undefined)
          }}
          onGrant={() => void access.decide(shown, 'granted')}
          onDecline={() => void access.decide(shown, 'declined')}
          onClose={close}
        />
      ) : null}
    </BottomDrawer>
  ) : null
  return { review: setReviewing, sheet }
}

const stylesSheet = themedStyleSheet((colors) => ({
  tile: {
    width: 48,
    height: 48,
    borderRadius: radii.control,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  tileWash: { ...StyleSheet.absoluteFill, opacity: 0.16 },
  warning: {
    fontSize: typography.bodySize,
    color: colors.textSecondary,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md
  }
}))
