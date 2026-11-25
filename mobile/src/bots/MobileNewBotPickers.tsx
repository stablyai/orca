import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { Shuffle } from '../components/icons/app-icons'
import type { BotAgent } from '../../../src/shared/bot-types'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { HostKindIcon } from '../components/icons/HostKindIcon'
import { COMPOSER_LINE_HEIGHT } from '../components/composer-input/composer-input-styles'
import { LIST_ROW_PADDING, ListRow } from '../components/list/ListGroup'
import { MobileAgentIcon } from '../components/icons/MobileAgentIcon'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, radii, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { MobileBotAvatarSource } from './host-bot-row-facts'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import { MobileBotAvatar } from './MobileBotAvatar'
import type { NewBotComputer } from './new-bot-computers'
import { readBotAgentChoices, readSignedInEmail } from './new-bot-host-reads'

/** New bot's picture, with Another picture's shuffle on its corner. */
export function NewBotPicture(props: { avatar: MobileBotAvatarSource; onShuffle: () => void }) {
  useMobileColorScheme()
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
  useMobileColorScheme()
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

const styles = themedStyleSheet(() => ({
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

const ROW_HEIGHT = 48
// The phone's own text fields drawn as rows of a group: no edge, fill or ring, the text on the row inset.
const unframed = {
  borderWidth: 0,
  borderRadius: 0,
  backgroundColor: 'transparent',
  outlineWidth: 0
} as const

export const groupFieldStyles = themedStyleSheet(() => ({
  line: { ...unframed, minHeight: ROW_HEIGHT, paddingHorizontal: LIST_ROW_PADDING },
  // The message text pads itself 6 across and 2 down; its first line sits where a one-line row's does.
  lines: {
    ...unframed,
    paddingHorizontal: LIST_ROW_PADDING - 6,
    paddingVertical: (ROW_HEIGHT - COMPOSER_LINE_HEIGHT) / 2 - spacing.xxs
  }
}))
