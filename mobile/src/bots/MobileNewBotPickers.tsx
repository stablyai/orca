import { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import type { BotAgent } from '../../../src/shared/bot-types'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { HostKindIcon } from '../components/icons/HostKindIcon'
import { ListGroup, ListRow } from '../components/list/ListGroup'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing, typography } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import type { NewBotComputer } from './new-bot-computers'
import { readBotAgentChoices, readSignedInEmail } from './new-bot-host-reads'

/** The chosen computer's agent choices; null until it answers. */
export function useNewBotAgentChoices(client: RpcClient | null): BotAgent[] | null {
  const [answer, setAnswer] = useState<{ client: RpcClient; agents: BotAgent[] } | null>(null)
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    void readBotAgentChoices(client).then((agents) => {
      if (live) {
        setAnswer({ client, agents })
      }
    })
    return () => {
      live = false
    }
  }, [client])
  return answer && answer.client === client ? answer.agents : null
}

/** A server signed in to another Orca account than the paired computer's: that account's email. */
export function useOtherOrcaAccount(
  server: RpcClient | null,
  paired: RpcClient | null
): string | null {
  const [answer, setAnswer] = useState<{ server: RpcClient; email: string | null } | null>(null)
  useEffect(() => {
    if (!server || !paired) {
      return
    }
    let live = true
    void Promise.all([readSignedInEmail(server), readSignedInEmail(paired)]).then(
      ([theirs, ours]) => {
        if (live) {
          setAnswer({ server, email: theirs && ours && theirs !== ours ? theirs : null })
        }
      }
    )
    return () => {
      live = false
    }
  }, [server, paired])
  return answer && answer.server === server ? answer.email : null
}

/** Runs on: the chosen computer, and what is true of it under the row. */
export function NewBotRunsOn(props: {
  computer: NewBotComputer | undefined
  /** A suggestion that takes over workspaces runs where they are. */
  locked: boolean
  reachable: boolean
  otherAccount: string | null
  onPick: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { computer } = props
  const label = computer?.label ?? ''
  const hasNote = !props.reachable || Boolean(props.otherAccount)
  return (
    <>
      <ListGroup style={hasNote ? undefined : styles.groupAlone}>
        <ListRow
          key="runs-on"
          title={t('bots.new.runsOn', 'Runs on')}
          accessory={
            <View style={styles.value}>
              <HostKindIcon hostId={computer?.hostId} size={14} />
              <Text style={styles.valueText} numberOfLines={1}>
                {label}
              </Text>
            </View>
          }
          navigates={!props.locked}
          {...(props.locked ? {} : { onPress: props.onPick })}
          accessibilityLabel={`${t('bots.new.runsOn', 'Runs on')}, ${label}`}
        />
      </ListGroup>
      {props.reachable ? null : (
        <Text style={styles.note}>
          {t('bots.new.cantReach', 'Can’t reach {{host}}. Pick another computer.', {
            host: label
          })}
        </Text>
      )}
      {props.reachable && props.otherAccount ? (
        <Text style={styles.note}>
          {t(
            'bots.new.otherAccount',
            '{{host}} uses its own Orca account ({{email}}). Its bots post and connect as that account.',
            { host: label, email: props.otherAccount }
          )}
        </Text>
      ) : null}
    </>
  )
}

/** Agent: the chosen agent, which opens the computer's choices; null when the computer has none. */
export function NewBotAgentRow(props: {
  agent: BotAgent | null
  hostLabel: string
  /** The computer hasn't said which agents it has yet: the row waits, as the desktop's picker does. */
  loading: boolean
  onPick: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { agent } = props
  const label = agent ? botAgentLabel(agent) : t('bots.new.noAgent', 'None')
  return (
    <>
      <ListGroup style={styles.agent}>
        <ListRow
          key="agent"
          title={t('bots.new.agent', 'Agent')}
          accessory={
            <View style={styles.value}>
              {props.loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
              {agent ? <MobileAgentIcon agentId={agent} size={14} /> : null}
              <Text style={styles.valueText} numberOfLines={1}>
                {label}
              </Text>
            </View>
          }
          navigates={agent !== null}
          busy={props.loading}
          {...(agent ? { onPress: props.onPick } : {})}
          accessibilityLabel={`${t('bots.new.agent', 'Agent')}, ${label}`}
        />
      </ListGroup>
      {agent ? null : (
        <Text style={styles.note}>
          {t('bots.new.noChatAgents', 'No chat agents available on {{host}}.', {
            host: props.hostLabel
          })}
        </Text>
      )}
    </>
  )
}

export function NewBotComputerSheet(props: {
  visible: boolean
  computers: readonly NewBotComputer[]
  chosen: string | null
  onPick: (computerId: string) => void
  onClose: () => void
}) {
  const t = useMobileTranslation()
  return (
    <ActionSheetModal
      visible={props.visible}
      title={t('bots.new.computer', 'Computer')}
      message={t('bots.new.computerMessage', 'Where the bot runs.')}
      onClose={props.onClose}
      actions={props.computers.map((computer) => ({
        id: computer.id,
        label: computer.label,
        renderIcon: () => <HostKindIcon hostId={computer.hostId} size={16} />,
        checked: computer.id === props.chosen,
        disabled: computer.refusal !== undefined,
        ...(computer.refusal ? { hint: computer.refusal } : {}),
        onPress: () => props.onPick(computer.id)
      }))}
    />
  )
}

export function NewBotAgentSheet(props: {
  visible: boolean
  hostLabel: string
  agents: readonly BotAgent[]
  chosen: BotAgent
  onPick: (agent: BotAgent) => void
  onClose: () => void
}) {
  const t = useMobileTranslation()
  return (
    <ActionSheetModal
      visible={props.visible}
      title={t('bots.new.agent', 'Agent')}
      message={t('bots.new.agentOn', 'On {{host}}.', { host: props.hostLabel })}
      onClose={props.onClose}
      actions={props.agents.map((agent) => ({
        id: agent,
        label: botAgentLabel(agent),
        renderIcon: () => <MobileAgentIcon agentId={agent} size={16} />,
        checked: agent === props.chosen,
        onPress: () => props.onPick(agent)
      }))}
    />
  )
}

const styles = themedStyleSheet(() => ({
  value: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: 180 },
  valueText: { fontSize: typography.bodySize, color: colors.textMuted, flexShrink: 1 },
  groupAlone: { marginBottom: spacing.md },
  note: {
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.xs
  },
  agent: { marginTop: spacing.md }
}))
