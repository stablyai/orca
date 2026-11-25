// Agent and model: the agents this bot's computer can run; switching asks first, as the desktop does,
// because the Home Chat starts over on the new agent.
import { useState, type ReactNode } from 'react'
import { RotateCcw } from 'lucide-react-native'
import { isBotAgent, type BotAgent } from '../../../src/shared/bot-types'
import {
  botLaunchFromChoices,
  botLaunchWithPicks,
  type BotLaunch
} from '../../../src/shared/bots/bot-launch'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { ConfirmContent } from '../components/sheets/ConfirmModal'
import { ListRow } from '../components/list/ListGroup'
import {
  CheckRow,
  ChoiceRows,
  DrillRow
} from '../host-screen/workspace-options/workspace-option-rows'
import { useBackClaim } from '../navigation/use-back-claim'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsSection } from '../settings/settings-screen-frame'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { SheetBot } from './bot-sheet-operations'
import { botAgentLabel } from './mobile-bot-sheet-copy'
import { useNewBotAgentChoices } from './MobileNewBotPickers'
import { useBotModelChoices } from './use-bot-model-choices'
import type { BotAgentSwitchPreviewResult } from '../../../src/shared/rpc-contract/bots-params'

export function MobileBotAgentPage(props: {
  bot: SheetBot
  client: RpcClient | null
  disabled: boolean
  online: boolean
  banner: ReactNode
  onBack: { label: string; onPress: () => void }
  /** Saves the new agent; its old launch belongs to the old agent, so it goes too. */
  onSwitch: (agent: BotAgent, consent: BotAgentSwitchPreviewResult['consent']) => Promise<void>
  previewSwitch: (agent: BotAgent) => Promise<BotAgentSwitchPreviewResult | null>
  /** Saves its model and options; null goes back to the chat defaults. */
  onLaunch: (launch: BotLaunch | null) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { bot } = props
  const choices = useNewBotAgentChoices(props.client)
  const [switching, setSwitching] = useState<
    (BotAgentSwitchPreviewResult & { agent: BotAgent }) | null
  >(null)
  const [picking, setPicking] = useState<'model' | 'effort' | null>(null)
  const modelChoices = useBotModelChoices(props.client, props.online, bot)
  useBackClaim(
    picking || switching
      ? () => {
          setPicking(null)
          setSwitching(null)
          return true
        }
      : null
  )
  const { model, modelId, effort } = modelChoices ?? {}
  const pick = (optionId: 'model' | 'effort', value: string) => {
    setPicking(null)
    const pickedModel = optionId === 'model' ? value : modelId
    // With no model known, an effort is kept on its own rather than adopting a model.
    const launch = pickedModel
      ? botLaunchWithPicks(bot.launch, [{ modelId: pickedModel, optionId, value }])
      : botLaunchFromChoices({ options: { ...bot.launch?.options, [optionId]: value } })
    if (launch && JSON.stringify(launch) !== JSON.stringify(bot.launch)) {
      props.onLaunch(launch)
    }
  }
  if (picking && modelChoices) {
    return (
      <>
        <SheetHeader
          title={
            picking === 'model'
              ? t('bots.settings.model', 'Model')
              : t('bots.settings.effort', 'Effort')
          }
          onBack={{
            label: t('bots.settings.backToAgent', 'Back to Agent and model'),
            onPress: () => setPicking(null)
          }}
        />
        {props.banner}
        {picking === 'model' ? (
          <ChoiceRows
            choices={modelChoices.models.map((choice) => ({
              id: choice.id,
              label: choice.label,
              ...(choice.description ? { description: choice.description } : {})
            }))}
            selected={model?.id ?? modelId ?? ''}
            disabled={props.disabled}
            onSelect={(id) => pick('model', id)}
          />
        ) : effort ? (
          <ChoiceRows
            choices={effort.option.kind.choices.map((choice) => ({
              id: choice.value,
              label: choice.label
            }))}
            selected={effort.value}
            disabled={props.disabled}
            onSelect={(value) => pick('effort', value)}
          />
        ) : null}
      </>
    )
  }
  if (switching) {
    const agent = botAgentLabel(switching.agent)
    return (
      <ConfirmContent
        title={t('bots.agentSwitch.title', 'Switch {{name}} to {{agent}}?', {
          name: bot.name,
          agent
        })}
        message={[
          t(
            'bots.agentSwitch.description',
            'Home Chat and new chats use {{agent}}. Your other chats keep their agent. Change any of them from its own picker.',
            { agent }
          ),
          '',
          t('bots.agentSwitch.kept', 'Kept: soul, memory, automations, connectors'),
          t(
            'bots.agentSwitch.homeContinues',
            'Home Chat continues on {{agent}} with its recent history',
            { agent }
          ),
          t(
            'bots.agentSwitch.newChats',
            'New Slack threads, automation runs and chats you open later start on {{agent}}',
            { agent }
          ),
          t(
            'bots.agentSwitch.threads',
            'Slack threads with an existing Orca chat keep that chat’s agent'
          ),
          ...(switching.consent
            ? [
                '',
                t(
                  'bots.agentSwitch.broaderAccess',
                  'Orca can’t require {{agent}} to ask before using tools. Allowing this applies to Home Chat and new work on this default.',
                  { agent }
                )
              ]
            : [])
        ].join('\n')}
        confirmLabel={
          switching.consent
            ? t('bots.agentSwitch.allowAction', 'Allow access and switch')
            : t('bots.agentSwitch.action', 'Switch to {{agent}}', { agent })
        }
        onCancel={() => setSwitching(null)}
        onConfirm={() => {
          setSwitching(null)
          void props.onSwitch(switching.agent, switching.consent)
        }}
      />
    )
  }
  // The current agent stays listed while the computer answers, and if it no longer offers it.
  const current = isBotAgent(bot.agent) ? [bot.agent] : []
  const agents: readonly BotAgent[] =
    choices && current.every((agent) => choices.includes(agent))
      ? choices
      : [...current, ...(choices ?? []).filter((agent) => agent !== bot.agent)]
  return (
    <>
      <SheetHeader
        title={t('bots.settings.agentAndModel', 'Agent and model')}
        onBack={props.onBack}
      />
      {props.banner}
      <SettingsSection title={t('bots.settings.agent', 'Agent')} first radioGroup>
        {agents.map((agent) => (
          <CheckRow
            key={agent}
            label={botAgentLabel(agent)}
            radio
            checked={agent === bot.agent}
            disabled={props.disabled}
            onPress={() => {
              if (agent !== bot.agent) {
                void props.previewSwitch(agent).then((preview) => {
                  if (preview) {
                    setSwitching({ agent, ...preview })
                  }
                })
              }
            }}
          />
        ))}
      </SettingsSection>
      {modelChoices && modelChoices.models.length > 0 ? (
        <SettingsSection
          title={botAgentLabel(bot.agent)}
          footer={
            bot.launch ? undefined : t('bots.settings.usingChatDefault', 'Using your chat default.')
          }
        >
          <DrillRow
            label={t('bots.settings.model', 'Model')}
            value={model?.label ?? modelId ?? t('bots.settings.modelDefault', 'Default')}
            disabled={props.disabled}
            onPress={() => setPicking('model')}
          />
          {effort ? (
            <DrillRow
              label={t('bots.settings.effort', 'Effort')}
              value={
                effort.option.kind.choices.find((choice) => choice.value === effort.value)?.label ??
                effort.value
              }
              disabled={props.disabled}
              onPress={() => setPicking('effort')}
            />
          ) : null}
        </SettingsSection>
      ) : null}
      {bot.launch ? (
        <SettingsSection>
          <ListRow
            leading={<RotateCcw size={18} color={colors.textPrimary} />}
            title={t('bots.settings.useChatDefaults', 'Use chat defaults')}
            disabled={props.disabled}
            onPress={() => props.onLaunch(null)}
          />
        </SettingsSection>
      ) : null}
    </>
  )
}
