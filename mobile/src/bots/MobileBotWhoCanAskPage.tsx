// Who can ask, a page of the bot's Settings, as the desktop's BotWhoCanAskPage: the requests waiting,
// then each connector's people and Add people, then Keep only me. Each change that takes access away or
// gives it asks first.
import { useState, type ReactNode } from 'react'
import { View } from 'react-native'
import { BOT_MAX_MEMBERS, botMemberSource, type BotMember } from '../../../src/shared/bot-types'
import { newBotMembers } from '../../../src/shared/bots/bot-access-request'
import { readBotMembersFull } from '../../../src/shared/bots/bot-member-capacity'
import type { ConnectorAccessRequest } from '../../../src/shared/connector-bot-access-contract'
import type { BotUpdateParams } from '../../../src/shared/rpc-contract/bots-params'
import { ListGroup, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import type { Translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useBackClaim } from '../navigation/use-back-claim'
import { SettingsNote, SettingsSection } from '../settings/settings-screen-frame'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { accessRequestGrant, type PhoneAccessBot } from './bot-access-request-copy'
import { MobileBotAccessDecisionContent } from './MobileBotAccessDecision'
import {
  botUpdate,
  memberRemoval,
  removeEveryoneWhoCanAsk,
  type SheetBot
} from './bot-sheet-operations'
import { MobileConnectorSourceIcon } from './MobileConnectorSourceIcon'
import { MobileBotWhoCanAskPicker } from './MobileBotWhoCanAskPicker'
import { MobileBotPairedServers } from './MobileBotPairedServers'
import type { RouteBot } from './use-route-bot'
import { useWhoCanAskConnectors } from './use-who-can-ask-connectors'
import type { WhoCanAskConnector } from './who-can-ask-connectors'
import { MobileAccessFixConfirm, MobileBotWhoCanAskEnd } from './MobileBotWhoCanAsk'
import {
  MobileWhoCanAskAddRow,
  MobileWhoCanAskPersonRow,
  MobileWhoCanAskRequestRow,
  WHO_FACE_INSET,
  whoCanAskName
} from './MobileWhoCanAskRows'
import type { BotAccessRequests } from './use-bot-access-requests'
import { mobileBotAccessCopy, mobileBotAccessNames } from './mobile-bot-access-copy'

/** One connector's list: its people and Add people. */
function ConnectorPeople(props: {
  connector: WhoCanAskConnector
  members: number
  locked: boolean
  onRemove: (member: BotMember) => void
  onAdd: () => void
}) {
  const t = useMobileTranslation()
  const { connector } = props
  const cap = Math.min(connector.max, BOT_MAX_MEMBERS - props.members + connector.listed.length)
  const capped = connector.search !== null && connector.listed.length >= cap
  const note = connector.search
    ? capped
      ? t('bots.whoCanAsk.cap', '{{count}} people is the most here.', { count: cap })
      : null
    : connector.checking
      ? null
      : connector.notYet
  return (
    <View>
      <SectionHeader
        title={connector.title}
        icon={<MobileConnectorSourceIcon source={connector.kind} size={14} />}
      />
      <ListGroup separatorInset={WHO_FACE_INSET}>
        {connector.listed.map((member) => (
          <MobileWhoCanAskPersonRow
            key={`${botMemberSource(member)}:${member.workspaceId ?? ''}:${member.id}`}
            member={member}
            busy={props.locked}
            onRemove={() => props.onRemove(member)}
          />
        ))}
        {/* A list kept only so its people can be removed offers no Add. */}
        {connector.search || connector.notYet ? (
          <MobileWhoCanAskAddRow
            disabled={connector.search === null || capped || props.locked}
            onPress={props.onAdd}
          />
        ) : null}
      </ListGroup>
      {note ? <SettingsNote>{note}</SettingsNote> : null}
    </View>
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
  hostName: string
  routeBot: Pick<RouteBot, 'applyBot' | 'reads' | 'hostKey'>
  onBack: { label: string; onPress: () => void }
  save: (updates: BotUpdateParams['updates']) => Promise<boolean>
  setSaving: (saving: boolean) => void
  showToast: (message: string, durationMs?: number) => void
}) {
  const t = useMobileTranslation()
  const { bot, access, client } = props
  const { applyBot } = props.routeBot
  const [removing, setRemoving] = useState<BotMember | null>(null)
  const [granting, setGranting] = useState<ConnectorAccessRequest | null>(null)
  const [fixing, setFixing] = useState<'only-me' | 'ask-for-approval' | null>(null)
  // Add people, then Give access; the picks survive a Cancel on the confirm.
  const [picking, setPicking] = useState<{
    key: string
    picked: BotMember[]
    confirming: boolean
  } | null>(null)
  const connectors = useWhoCanAskConnectors(client, bot, props.routeBot, props.hostName, t)
  const adding = picking ? connectors.find((entry) => entry.key === picking.key) : undefined
  // Its list went away (an org or workspace removed meanwhile): nothing is left to add to.
  if (picking && !adding) {
    setPicking(null)
  }
  useBackClaim(
    removing || granting || fixing || picking
      ? () => {
          if (picking?.confirming) {
            setPicking({ ...picking, confirming: false })
          } else {
            setRemoving(null)
            setGranting(null)
            setFixing(null)
            setPicking(null)
          }
          return true
        }
      : null
  )

  if (picking && adding) {
    const add = async (connector: WhoCanAskConnector, picked: BotMember[]) => {
      if (!client) {
        return
      }
      props.setSaving(true)
      try {
        const updates = {
          addMembers: newBotMembers(bot.members, picked, {
            listed: () => connector.listed,
            stamp: connector.stamp
          })
        }
        applyBot(
          botUpdate.interpret(
            await botUpdate.request(
              client,
              { botId: bot.id, updates },
              { failWhenDisconnected: true }
            )
          ).bot
        )
      } catch (error) {
        props.showToast(addFailedLine(error, picked, t), 2400)
      } finally {
        props.setSaving(false)
      }
    }
    return picking.confirming ? (
      // Adding anyone lets them drive the agent, and through it the computer, so it always asks first.
      <MobileBotAccessDecisionContent
        grant={{
          people: picking.picked.map((member) => ({
            id: member.id,
            name: member.name || member.id
          })),
          connector: adding.kind,
          workspace: adding.workspace
        }}
        bot={bot}
        onGrant={() => {
          setPicking(null)
          void add(adding, picking.picked)
        }}
        // Also called after Give access, which has closed the picker by then.
        onClose={() => setPicking((open) => open && { ...open, confirming: false })}
      />
    ) : (
      <MobileBotWhoCanAskPicker
        connector={adding}
        members={bot.members}
        initialPicked={picking.picked}
        onCancel={() => setPicking(null)}
        onPicked={(picked) => setPicking({ key: adding.key, picked, confirming: true })}
      />
    )
  }

  if (removing) {
    return (
      <ConfirmContent
        title={t('bots.settings.removeConfirmTitle', 'Remove {{name}}?', {
          name: whoCanAskName(removing)
        })}
        message={t(
          'bots.settings.removeConfirmMessage',
          '{{name}} can no longer ask {{botName}}.',
          { name: whoCanAskName(removing), botName: bot.name }
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

  const keepOnlyMe = async (host: RpcClient) => {
    props.setSaving(true)
    const failed = await removeEveryoneWhoCanAsk(host, bot, applyBot)
    props.setSaving(false)
    if (failed.length > 0) {
      props.showToast(
        mobileBotAccessCopy(t, 'fixOnlyMeFailed', { names: mobileBotAccessNames(failed) }),
        2400
      )
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
          } else if (client) {
            void keepOnlyMe(client)
          }
        }}
      />
    )
  }

  // Any paired phone may grant (D3), so it always asks first, as the desktop does.
  if (granting && access) {
    return (
      <MobileBotAccessDecisionContent
        grant={accessRequestGrant(granting)}
        bot={bot}
        onGrant={() => void access.decide(granting, 'granted')}
        onClose={() => setGranting(null)}
      />
    )
  }

  const requests = access?.requests ?? []
  return (
    <>
      <SheetHeader title={t('bots.settings.whoCanAsk', 'Who can ask')} onBack={props.onBack} />
      {props.banner}
      {access && requests.length > 0 ? (
        <SettingsSection title={mobileBotAccessCopy(t, 'heading')} separatorInset={WHO_FACE_INSET}>
          {requests.map((request) => (
            <MobileWhoCanAskRequestRow
              key={request.requestId}
              request={request}
              busy={access.deciding || !props.online}
              onReview={() => setGranting(request)}
              onDecline={() => void access.decide(request, 'declined')}
            />
          ))}
        </SettingsSection>
      ) : null}
      {connectors.map((connector) => (
        <ConnectorPeople
          key={connector.key}
          connector={connector}
          members={bot.members.length}
          locked={props.locked}
          onRemove={setRemoving}
          onAdd={() => setPicking({ key: connector.key, picked: [], confirming: false })}
        />
      ))}
      <MobileBotPairedServers
        client={client}
        bot={bot}
        locked={props.locked}
        showToast={props.showToast}
      />
      <MobileBotWhoCanAskEnd
        bot={bot}
        disabled={props.locked}
        onKeepOnlyMe={() => setFixing('only-me')}
        onAskForApproval={() => setFixing('ask-for-approval')}
      />
    </>
  )
}

/** Why an add saved nobody: past a limit, named as the desktop does, or simply who. */
function addFailedLine(error: unknown, picked: readonly BotMember[], t: Translate): string {
  const full = readBotMembersFull(error)
  if (!full) {
    return t('bots.whoCanAsk.addFailed', 'Couldn’t add {{names}}.', {
      names: mobileBotAccessNames(picked.map((member) => member.name || member.id))
    })
  }
  const values = { names: mobileBotAccessNames(full.names), count: full.limit }
  return full.scope === 'bot'
    ? t(
        'bots.whoCanAsk.fullBot',
        'Nobody was added: {{names}} would go past the {{count}} people a bot can have.',
        values
      )
    : t(
        'bots.whoCanAsk.fullWorkspace',
        'Nobody was added: {{names}} would go past the {{count}} people this workspace can have.',
        values
      )
}
