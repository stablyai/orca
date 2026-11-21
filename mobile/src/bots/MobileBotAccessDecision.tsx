// The desktop's "Give access" confirm on the phone: who asked and where, the warning in its tone, and
// what they would reach. As a sheet, Decline answers here too; closing any other way leaves the request
// waiting.
import { useEffect, useState, type ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Laptop, Mail, ShieldAlert, ShieldOff, type LucideIcon } from 'lucide-react-native'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import { BOT_ACCESS_COPY, botAccessCopy } from '../../../src/shared/bots/bot-access-copy'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { BotPanelOpen } from './MobileBotPanel'
import {
  ACCESS_REQUEST_EXPIRED_LINE,
  accessDecisionCopy,
  phoneAccessHost,
  type AccessDecisionRow,
  type PhoneAccessBot
} from './bot-access-request-copy'
import { readConnectionStatusProbe } from '../transport/connection/runtime-status-probe'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { BotAccessRequests } from './use-bot-access-requests'
import { MobileConnectorSourceIcon } from './MobileConnectorSourceIcon'

const ROW_ICONS: Partial<Record<AccessDecisionRow['kind'], LucideIcon>> = {
  computer: Laptop,
  'no-approvals': ShieldOff,
  'may-skip-approvals': ShieldAlert,
  approves: ShieldAlert,
  google: Mail
}

function RowIcon({ row }: { row: AccessDecisionRow }) {
  if (row.connector) {
    return <MobileConnectorSourceIcon source={row.connector} size={16} />
  }
  const Icon = ROW_ICONS[row.kind] ?? ShieldAlert
  return (
    <Icon size={17} strokeWidth={2} color={row.warn ? colors.statusRed : colors.textSecondary} />
  )
}

export function MobileBotAccessDecisionContent({
  request,
  bot,
  onGrant,
  onDecline,
  onClose
}: {
  request: ConnectorAccessRequest
  bot: PhoneAccessBot
  onGrant: () => void
  /** Decline in place of Cancel, where nothing else beside the confirm declines. */
  onDecline?: () => void
  onClose: () => void
}) {
  useMobileColorScheme()
  const copy = accessDecisionCopy(request, bot)
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
          <SectionHeader title={botAccessCopy('whatTheyCanDo', { person: copy.firstName })} first />
          <ListGroup>
            {copy.rows.map((row) => (
              <ListRow key={row.kind} title={row.text} leading={<RowIcon row={row} />} />
            ))}
          </ListGroup>
          <Text style={styles.footer}>{BOT_ACCESS_COPY.removeAnyTime}</Text>
        </>
      }
      {...(onDecline ? { cancelLabel: BOT_ACCESS_COPY.decline, onCancelPress: onDecline } : {})}
      confirmLabel={BOT_ACCESS_COPY.confirm}
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
      showToast(ACCESS_REQUEST_EXPIRED_LINE)
    }
  }, [missing, showToast])
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
          request={shown}
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

const styles = themedStyleSheet(() => ({
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
  },
  footer: {
    fontSize: typography.metaSize,
    color: colors.textSecondary,
    marginTop: spacing.sm,
    paddingHorizontal: spacing.xs
  }
}))
