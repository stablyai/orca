import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { Shuffle } from 'lucide-react-native'
import type { BotAgent } from '../../../src/shared/bot-types'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { HostKindIcon } from '../components/icons/HostKindIcon'
import { ListRow } from '../components/list/ListGroup'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import { useMobileColors } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import { MobileBotAvatar } from './MobileBotAvatar'
import type { NewBotComputer } from './new-bot-computers'
import {
  readNewBotAgentChoices,
  readSignedInEmail,
  type NewBotAgentChoices
} from './new-bot-host-reads'

/** New bot's picture, with Another picture's shuffle on its corner. */
export function NewBotPicture(props: { avatar: MobileBotAvatarSource; onShuffle: () => void }) {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  return (
    <View>
      <MobileBotAvatar avatar={props.avatar} size={72} />
      <Pressable
        style={({ pressed }) => [styles.shuffle, pressed && styles.pressed]}
        onPress={props.onShuffle}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('bots.new.shuffle', 'Another picture')}
      >
        <Shuffle size={14} color={colors.textSecondary} />
      </Pressable>
    </View>
  )
}

/** The chosen computer's agent choices; null until it answers. */
export function useNewBotAgentChoices(client: RpcClient | null): NewBotAgentChoices | null {
  const [answer, setAnswer] = useState<{ client: RpcClient; choices: NewBotAgentChoices } | null>(
    null
  )
  useEffect(() => {
    if (!client) {
      return
    }
    let live = true
    void readNewBotAgentChoices(client).then((choices) => {
      if (live) {
        setAnswer({ client, choices })
      }
    })
    return () => {
      live = false
    }
  }, [client])
  return answer && answer.client === client ? answer.choices : null
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

/** Runs on: the chosen computer; locked for a suggestion that takes workspaces over where they are. */
export function NewBotRunsOnRow(props: {
  computer: NewBotComputer | undefined
  locked: boolean
  onPick: () => void
}) {
  const t = useMobileTranslation()
  const label = props.computer?.label ?? ''
  return (
    <ListRow
      title={t('bots.new.runsOn', 'Runs on')}
      value={label}
      valueIcon={<HostKindIcon hostId={props.computer?.hostId} size={14} />}
      navigates={!props.locked}
      {...(props.locked ? {} : { onPress: props.onPick })}
    />
  )
}

/** Agent: the chosen agent, which opens the computer's choices; null when the computer has none. */
export function NewBotAgentRow(props: {
  agent: BotAgent | null
  /** The computer hasn't said which agents it has yet: the row waits, as the desktop's picker does. */
  loading: boolean
  onPick: () => void
}) {
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const { agent } = props
  return (
    <ListRow
      title={t('bots.new.agent', 'Agent')}
      value={agent ? botAgentLabel(agent) : t('bots.new.noAgent', 'None')}
      {...(agent ? { valueIcon: <MobileAgentIcon agentId={agent} size={14} /> } : {})}
      accessory={
        props.loading ? <ActivityIndicator size="small" color={colors.textMuted} /> : undefined
      }
      navigates={agent !== null}
      busy={props.loading}
      {...(agent ? { onPress: props.onPick } : {})}
    />
  )
}

/** The one thing true of the chosen computer that stops or changes the bot, under its rows. */
export function newBotComputerNote(
  t: ReturnType<typeof useMobileTranslation>,
  facts: { host: string; reachable: boolean; otherAccount: string | null; noAgents: boolean }
): string | null {
  if (!facts.reachable) {
    return t('bots.new.cantReach', 'Can’t reach {{host}}. Pick another computer.', {
      host: facts.host
    })
  }
  if (facts.noAgents) {
    return t('bots.new.noChatAgents', 'No chat agents available on {{host}}.', { host: facts.host })
  }
  return facts.otherAccount
    ? t(
        'bots.new.otherAccount',
        '{{host}} uses its own Orca account ({{email}}). Its bots post and connect as that account.',
        { host: facts.host, email: facts.otherAccount }
      )
    : null
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

const stylesSheet = themedStyleSheet((colors) => ({
  shuffle: {
    position: 'absolute',
    right: -spacing.sm,
    bottom: -spacing.sm,
    padding: spacing.xs,
    borderRadius: radii.pill,
    // bgRaised is the light sheet's own colour; the group fill lifts off the sheet in both themes.
    backgroundColor: colors.sheetGroup
  },
  pressed: { opacity: 0.7 }
}))
