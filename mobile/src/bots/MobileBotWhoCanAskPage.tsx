// Who can ask, a page of the bot's Settings: waiting access requests, the people who can ask, and the
// desktop's advice. Each change that takes access away or gives it asks first.
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { botMemberSource, type BotMember } from '../../../src/shared/bot-types'
import { accessRequestPerson } from '../../../src/shared/bots/bot-access-request'
import { BOT_ACCESS_COPY, botAccessCopy } from '../../../src/shared/bots/bot-access-copy'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import type { BotUpdateParams } from '../../../src/shared/rpc-contract/bots-params'
import { ListRow } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from '../settings/settings-screen-frame'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { accessRequestLine, type PhoneAccessBot } from './bot-access-request-copy'
import { MobileBotAccessDecisionContent } from './MobileBotAccessDecision'
import { memberRemoval, removeEveryoneWhoCanAsk, type SheetBot } from './bot-sheet-operations'
import { optionStyles } from './mobile-bot-option-styles'
import { MobileBotTextButton } from './MobileBotTextButton'
import {
  MobileAccessFixConfirm,
  MobileBotMemberRow,
  MobileBotWhoCanAsk
} from './MobileBotWhoCanAsk'
import type { BotAccessRequests } from './use-bot-access-requests'

function AccessRequestRow(props: {
  request: ConnectorAccessRequest
  disabled: boolean
  onDecline: () => void
  onReview: () => void
}) {
  const t = useMobileTranslation()
  const person = accessRequestPerson(props.request)
  return (
    <ListRow
      title={person}
      subtitle={accessRequestLine(props.request)}
      accessory={
        <View style={optionStyles.rowActions}>
          <MobileBotTextButton
            label={BOT_ACCESS_COPY.decline}
            accessibilityLabel={t('bots.settings.declineName', 'Decline {{name}}', {
              name: person
            })}
            disabled={props.disabled}
            onPress={props.onDecline}
          />
          <MobileBotTextButton
            label={BOT_ACCESS_COPY.review}
            accessibilityLabel={t('bots.settings.reviewName', 'Review {{name}}', { name: person })}
            disabled={props.disabled}
            onPress={props.onReview}
          />
        </View>
      }
    />
  )
}

export function MobileBotWhoCanAskPage(props: {
  bot: SheetBot & PhoneAccessBot
  client: RpcClient | null
  access: BotAccessRequests | null
  online: boolean
  /** A save is in flight, or the host is offline. */
  locked: boolean
  banner: ReactNode
  onBack: { label: string; onPress: () => void }
  save: (updates: BotUpdateParams['updates']) => Promise<boolean>
  applyBot: (bot: SheetBot) => void
  setSaving: (saving: boolean) => void
  showToast: (message: string, durationMs?: number) => void
}) {
  const t = useMobileTranslation()
  const { bot, access } = props
  const [removing, setRemoving] = useState<BotMember | null>(null)
  const [granting, setGranting] = useState<ConnectorAccessRequest | null>(null)
  const [fixing, setFixing] = useState<'only-me' | 'ask-for-approval' | null>(null)

  if (removing) {
    return (
      <ConfirmContent
        title={t('bots.settings.removeConfirmTitle', 'Remove {{name}}?', { name: removing.name })}
        message={t(
          'bots.settings.removeConfirmMessage',
          '{{name}} can no longer ask {{botName}}.',
          { name: removing.name, botName: bot.name }
        )}
        confirmLabel={t('bots.settings.remove', 'Remove')}
        destructive
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          const member = removing
          setRemoving(null)
          void props.save(memberRemoval(member))
        }}
      />
    )
  }

  const keepOnlyMe = async (client: RpcClient) => {
    props.setSaving(true)
    const failed = await removeEveryoneWhoCanAsk(client, bot, props.applyBot)
    props.setSaving(false)
    if (failed.length > 0) {
      props.showToast(botAccessCopy('fixOnlyMeFailed', { names: failed.join(', ') }), 2400)
    }
  }
  if (fixing) {
    return (
      <MobileAccessFixConfirm
        fix={fixing}
        bot={bot}
        onCancel={() => setFixing(null)}
        onConfirm={() => {
          setFixing(null)
          if (fixing === 'ask-for-approval') {
            void props.save({ permissionMode: 'ask' })
          } else if (props.client) {
            void keepOnlyMe(props.client)
          }
        }}
      />
    )
  }

  // Any paired phone may grant (D3), so it always asks first, as the desktop does.
  if (granting && access) {
    return (
      <MobileBotAccessDecisionContent
        request={granting}
        bot={bot}
        onGrant={() => void access.decide(granting, 'granted')}
        onClose={() => setGranting(null)}
      />
    )
  }

  return (
    <>
      <SheetHeader title={t('bots.settings.whoCanAsk', 'Who can ask')} onBack={props.onBack} />
      {props.banner}
      {access && access.requests.length > 0 ? (
        <SettingsSection title={BOT_ACCESS_COPY.heading}>
          {access.requests.map((request) => (
            <AccessRequestRow
              key={request.requestId}
              request={request}
              disabled={access.deciding || !props.online}
              onDecline={() => void access.decide(request, 'declined')}
              onReview={() => setGranting(request)}
            />
          ))}
        </SettingsSection>
      ) : null}
      <MobileBotWhoCanAsk
        bot={bot}
        disabled={props.locked}
        onKeepOnlyMe={() => setFixing('only-me')}
        onAskForApproval={() => setFixing('ask-for-approval')}
      >
        {bot.members.map((member) => (
          <MobileBotMemberRow
            key={`${botMemberSource(member)}:${member.workspaceId ?? ''}:${member.id}`}
            member={member}
            disabled={props.locked}
            onRemove={() => setRemoving(member)}
          />
        ))}
      </MobileBotWhoCanAsk>
    </>
  )
}
