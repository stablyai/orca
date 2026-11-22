// Where an agent's automation runs and where its results go: the desktop sidebar's Runs in, Agent and
// Send results to, in its order, with the options that can't work yet shown with their reason.
import { CircleOff, Hash, MessageCircle, MessageSquare } from 'lucide-react-native'
import type { AgentType } from '../../../src/shared/agent-status/contracts/agent-status-types'
import { getAgentSessionOptionLaunchCatalog } from '../../../src/shared/agent-session/options/agent-session-option-catalog'
import type { AutomationBotTarget } from '../../../src/shared/automations/automation-definition'
import { botResultsPlace } from '../../../src/shared/automation-bot-target'
import {
  botResultsToChoice,
  botResultsToOf,
  withBotResultsPlace,
  type BotResultsToChoice
} from '../../../src/shared/automations/bot-automation-target-edit'
import { botAutomationSetup } from '../../../src/shared/bots/bot-agent-setup'
import { isBotAgent, type BotAgent } from '../../../src/shared/bot-types'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import type { PickerOption } from '../components/sheets/PickerModal'
import { FieldTextInput } from '../components/composer-input/FieldTextInput'
import { SwitchRow } from '../host-screen/workspace-options/workspace-option-rows'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { MobileConnectorSourceIcon } from '../bots/MobileConnectorSourceIcon'
import { botAgentLabel } from '../bots/mobile-bot-sheet-copy'
import type { PhoneBot } from '../bots/host-bots-operations'
import { automationStyles as styles } from './automation-styles'
import type { PresentAutomationSheet } from './AutomationSheets'

const RUNS_IN_SAVED_CHAT = 'saved-chat'
const SAME_AS_BOT = 'same'

/** "Claude Code · Sonnet 5.5": an agent and the model its launch picks. */
function setupLine(agent: AgentType, model: string | undefined): string {
  const label = model
    ? (getAgentSessionOptionLaunchCatalog(agent)?.models.find((entry) => entry.id === model)
        ?.label ?? model)
    : undefined
  return [botAgentLabel(agent), label].filter(Boolean).join(' · ')
}

/** A row that reads as its choice, opening the choices in a sheet. */
function ChoiceRow<Value extends string>(props: {
  title: string
  subtitle?: string
  sheetTitle: string
  value: Value
  options: PickerOption<Value>[]
  onSelect: (value: Value) => void
  present: PresentAutomationSheet
  disabled?: boolean
}) {
  return (
    <ListRow
      title={props.title}
      subtitle={props.subtitle}
      navigates={!props.disabled}
      disabled={props.disabled}
      onPress={() =>
        props.present({
          kind: 'picker',
          title: props.sheetTitle,
          options: props.options,
          selected: props.value,
          onSelect: (value) => {
            const option = props.options.find((entry) => entry.value === value)
            if (option) {
              props.onSelect(option.value)
            }
          }
        })
      }
    />
  )
}

export function BotAutomationTargetRows(props: {
  target: AutomationBotTarget
  bot: PhoneBot
  /** Only Slack, GitHub or Linear events start it, so each run has a thread to answer in. */
  hasEventThread: boolean
  /** The agent's computer's Orca Cloud binds an event's run to its thread. */
  threadReplies: boolean
  /** The agents its host can start; null until read. */
  agents: readonly BotAgent[] | null
  onChange: (target: AutomationBotTarget) => void
  present: PresentAutomationSheet
  disabled: boolean
}) {
  const t = useMobileTranslation()
  const { target, bot, onChange } = props
  const name = bot.name
  const chatLabel = t('automations.botTarget.chat', "{{name}}'s Chat", { name })
  const newLabel = t('automations.botTarget.runsInNew', 'A new conversation each time')
  const savedChatLabel = target.chat
    ? target.chat.title || t('automations.botTarget.runsInUntitledChat', 'An untitled chat')
    : ''
  const runsIn = target.chat ? RUNS_IN_SAVED_CHAT : target.runsIn
  const runsInOptions: PickerOption<string>[] = [
    { value: 'new', label: newLabel },
    { value: 'chat', label: chatLabel },
    // A chat only the CLI picks, so it is offered only once saved.
    ...(target.chat ? [{ value: RUNS_IN_SAVED_CHAT, label: savedChatLabel }] : [])
  ]

  const inChat = target.runsIn !== 'new'
  // An agent this build doesn't know can't have a setup of its own read here either.
  const setup = isBotAgent(bot.agent)
    ? botAutomationSetup(target, {
        agent: bot.agent,
        ...(bot.launch ? { launch: bot.launch } : {})
      })
    : null
  const own = setup?.own ? setup : null
  const sameAs = t('automations.botTarget.agentSameAsBot', 'Same as {{name}}', { name })
  const botLine = setupLine(bot.agent, bot.launch?.model)
  const agentOptions: PickerOption<string>[] = [
    { value: SAME_AS_BOT, label: sameAs, subtitle: botLine },
    ...(props.agents ?? []).map((agent) => ({ value: agent, label: botAgentLabel(agent) })),
    // Its own agent stays offered when the host no longer lists it.
    ...(own && !props.agents?.includes(own.agent)
      ? [{ value: own.agent, label: botAgentLabel(own.agent) }]
      : [])
  ]

  const choice = botResultsToChoice(target.resultsTo)
  const posted = typeof target.resultsTo === 'object' ? target.resultsTo : null
  const threadReady = props.threadReplies && props.hasEventThread && target.runsIn === 'new'
  const icon = (Icon: typeof MessageSquare) => () => (
    <Icon size={18} color={colors.textSecondary} strokeWidth={1.8} />
  )
  const resultOptions: PickerOption<BotResultsToChoice>[] = [
    { value: 'chat', label: chatLabel, renderIcon: icon(MessageSquare) },
    {
      value: 'thread',
      label: t('automations.botTarget.resultsToThread', "The event's thread"),
      // A thread answer needs its own conversation each run, and an event that has a thread.
      ...(threadReady || choice === 'thread'
        ? {}
        : {
            disabled: true,
            subtitle: props.threadReplies
              ? t('automations.botTarget.threadNeedsEvents', 'Only events, new conversation')
              : t('automations.botTarget.threadUnsupported', "Orca Cloud doesn't support this yet")
          }),
      renderIcon: icon(MessageCircle)
    },
    {
      value: 'channel',
      label: t('automations.botTarget.resultsToChannel', 'A channel'),
      // A channel post goes through the agent's Slack app, so it needs one.
      ...(bot.slack || choice === 'channel'
        ? {}
        : {
            disabled: true,
            subtitle: t('automations.botTarget.channelNeedsSlack', 'Connect Slack first')
          }),
      renderIcon: icon(Hash)
    },
    {
      value: 'linear',
      label: t('automations.botTarget.resultsToLinear', 'A Linear issue'),
      ...(bot.linear || choice === 'linear'
        ? {}
        : {
            disabled: true,
            subtitle: t('automations.botTarget.linearNeedsLinear', 'Connect Linear first')
          }),
      renderIcon: () => <MobileConnectorSourceIcon source="linear" size={16} />
    },
    {
      value: 'none',
      label: t('automations.botTarget.resultsToNone', 'Nowhere'),
      renderIcon: icon(CircleOff)
    }
  ]
  const resultsTitle = t('automations.botTarget.resultsTo', 'Send results to')

  return (
    <>
      <SectionHeader title={t('automations.botTarget.runsIn', 'Runs in')} />
      <ListGroup>
        <ChoiceRow
          title={runsInOptions.find((option) => option.value === runsIn)?.label ?? newLabel}
          sheetTitle={t('automations.botTarget.runsIn', 'Runs in')}
          value={runsIn}
          options={runsInOptions}
          present={props.present}
          disabled={props.disabled}
          onSelect={(next) => {
            if (next === RUNS_IN_SAVED_CHAT) {
              return
            }
            // A run in a chat stays on that chat's agent, so its own agent goes.
            const { agentSetup, ...rest } = target
            onChange({
              ...rest,
              runsIn: next === 'chat' ? 'chat' : 'new',
              chat: undefined,
              ...(next === 'new' && agentSetup ? { agentSetup } : {})
            })
          }}
        />
      </ListGroup>
      <SectionHeader title={t('automations.botTarget.agent', 'Agent')} />
      <ListGroup>
        {inChat ? (
          <ListRow
            title={t('automations.botTarget.agentInChat', "This chat's agent")}
            subtitle={t(
              'automations.botTarget.agentInChatHelp',
              "A run in a chat continues on that chat's agent."
            )}
            disabled
          />
        ) : (
          <ChoiceRow
            title={own ? botAgentLabel(own.agent) : sameAs}
            subtitle={own ? undefined : botLine}
            sheetTitle={t('automations.botTarget.agent', 'Agent')}
            value={own ? own.agent : SAME_AS_BOT}
            options={agentOptions}
            present={props.present}
            disabled={props.disabled}
            onSelect={(next) => {
              const { agentSetup, ...rest } = target
              if (next === SAME_AS_BOT) {
                onChange(rest)
              } else if (isBotAgent(next) && next !== own?.agent) {
                onChange({ ...rest, agentSetup: { agent: next } })
              } else if (agentSetup) {
                onChange({ ...rest, agentSetup })
              }
            }}
          />
        )}
      </ListGroup>
      <SectionHeader title={resultsTitle} />
      <ListGroup>
        <ChoiceRow
          title={resultOptions.find((option) => option.value === choice)?.label ?? chatLabel}
          sheetTitle={resultsTitle}
          value={choice}
          options={resultOptions}
          present={props.present}
          disabled={props.disabled}
          onSelect={(next) => {
            if (next !== choice) {
              onChange({ ...target, resultsTo: botResultsToOf(next) })
            }
          }}
        />
        {/* A run in the Chat itself already left its result there for the agent. */}
        {choice === 'chat' && target.runsIn === 'new' ? (
          <SwitchRow
            label={t('automations.botTarget.letBotReact', 'Let {{name}} react', { name })}
            detail={t(
              'automations.botTarget.letBotReactHelp',
              'Each result starts a turn so {{name}} can act on it.',
              { name }
            )}
            value={target.letBotReact === true}
            onChange={(letBotReact) => onChange({ ...target, letBotReact })}
            disabled={props.disabled}
          />
        ) : null}
      </ListGroup>
      {posted ? (
        <FieldTextInput
          style={[styles.input, styles.placeField]}
          value={botResultsPlace(posted)}
          placeholder={
            choice === 'channel'
              ? t('automations.botTarget.channelPlaceholder', '#channel or a Slack link')
              : t(
                  'automations.botTarget.linearIssuePlaceholder',
                  'Issue key (e.g. ENG-123) or a Linear link'
                )
          }
          accessibilityLabel={
            choice === 'channel'
              ? t('automations.botTarget.channelLabel', 'Channel')
              : t('automations.botTarget.linearIssueLabel', 'Linear issue')
          }
          autoCapitalize="none"
          autoCorrect={false}
          editable={!props.disabled}
          onChangeText={(place) =>
            onChange({ ...target, resultsTo: withBotResultsPlace(posted, place) })
          }
        />
      ) : null}
    </>
  )
}
