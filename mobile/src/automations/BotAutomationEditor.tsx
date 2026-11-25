// An agent's automation, edited as on the desktop: its name and prompt, the agent it runs as, When,
// its events (changed by chatting with the agent), where it runs and where its results go.
import { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { Zap } from 'lucide-react-native'
import type { AutomationOwnerPrecondition } from '../../../src/shared/automations/ownership/automation-owner-precondition'
import type { AutomationEventSource } from '../../../src/shared/automation-event-triggers'
import {
  botEventsHaveThreads,
  missingBotResultsPlace
} from '../../../src/shared/automations/bot-automation-target-edit'
import type { BotAgent } from '../../../src/shared/bot-types'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { FieldTextInput } from '../components/composer-input/FieldTextInput'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors, spacing } from '../theme/mobile-theme'
import { themedStyleSheet } from '../theme/themed-styles'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { MobileBotAvatar } from '../bots/MobileBotAvatar'
import { mobileBotAvatarSource } from '../bots/host-bot-row-facts'
import type { PhoneBot } from '../bots/host-bots-operations'
import { eventLabel } from '../bots/mobile-bot-sheet-copy'
import { readBotAgentChoices } from '../bots/new-bot-host-reads'
import type { MobileAutomation } from './automation-reply-schema'
import { automationShowRead, automationUpdateWrite } from './automation-operations'
import { automationErrorMessage } from './automation-error'
import { automationStyles } from './automation-styles'
import {
  botAutomationChanged,
  botAutomationDraft,
  botAutomationUpdates,
  type BotAutomationDraft
} from './bot-automation-edit-draft'
import { BotAutomationTargetRows } from './BotAutomationTargetRows'
import { BotAutomationWhenRows } from './BotAutomationWhenRows'
import type { PresentAutomationSheet } from './AutomationSheets'
import type { AutomationLeaveSlot } from './AutomationEditorNavigation'

type Trigger = { id: string; source: AutomationEventSource; event?: string }

function savedTriggers(automation: MobileAutomation): Trigger[] {
  const on: unknown = automation.on
  return Array.isArray(on)
    ? on.filter(
        (trigger): trigger is Trigger =>
          typeof trigger === 'object' &&
          trigger !== null &&
          'source' in trigger &&
          typeof trigger.source === 'string' &&
          'id' in trigger &&
          typeof trigger.id === 'string'
      )
    : []
}

export function BotAutomationEditor(props: {
  client: RpcClient | null
  automationId: string
  expectedOwner?: AutomationOwnerPrecondition
  /** The agents it can run as, its own first once found; its own is null when it was deleted. */
  bots: readonly PhoneBot[]
  /** The agent's computer's Orca Cloud answers events in their own thread. */
  threadReplies: boolean
  online: boolean
  onBack: () => void
  onSaved: (automation: MobileAutomation) => void
  /** Drafts a message in the chat of the agent that owns it; null where that chat isn't open. */
  onAskInChat: ((draft: string) => void) | null
  present: PresentAutomationSheet
  /** Filled while open, so the page's tab and host switches ask before dropping its edits. */
  leaveGuard?: AutomationLeaveSlot
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [saved, setSaved] = useState<MobileAutomation | null>(null)
  const [draft, setDraft] = useState<BotAutomationDraft | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [agents, setAgents] = useState<BotAgent[] | null>(null)
  const [reload, setReload] = useState(0)
  // A save that lands after the editor closed must not move the page it left.
  const open = useRef(true)
  useEffect(
    () => () => {
      open.current = false
    },
    []
  )
  const { client, automationId, expectedOwner } = props

  useEffect(() => {
    if (!client) {
      return
    }
    let active = true
    void automationShowRead
      .request(client, { id: automationId, ...(expectedOwner ? { expectedOwner } : {}) })
      .then((reply) => {
        if (active) {
          const { automation } = automationShowRead.interpret(reply)
          // A new connection re-reads it; the edits and the record they are measured from both stay,
          // so a save sends only what was edited here.
          setSaved((current) => current ?? automation)
          setDraft((current) => current ?? botAutomationDraft(automation))
          setError(null)
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(automationErrorMessage(failure))
        }
      })
    void readBotAgentChoices(client).then((choices) => active && setAgents(choices))
    return () => {
      active = false
    }
  }, [client, automationId, expectedOwner, reload])

  const target = draft?.target ?? null
  const bot = target ? (props.bots.find((entry) => entry.id === target.botId) ?? null) : null
  const events = saved ? savedTriggers(saved) : []
  const changed = saved !== null && draft !== null && botAutomationChanged(saved, draft)
  const disabled = busy || !props.online || !draft
  const askInChat = props.onAskInChat
  const leave = (then: () => void) =>
    changed
      ? props.present({
          kind: 'confirm',
          title: t('automations.mobile.discardChangesTitle', 'Discard changes?'),
          message: t(
            'automations.mobile.discardChangesMessage',
            'Unsaved edits to this automation will be lost.'
          ),
          confirmLabel: t('automations.mobile.discard', 'Discard'),
          cancelLabel: t('automations.mobile.keepEditing', 'Keep editing'),
          destructive: true,
          onConfirm: then
        })
      : then()
  useEffect(() => {
    const slot = props.leaveGuard
    if (!slot) {
      return
    }
    slot.current = leave
    return () => {
      slot.current = null
    }
  })

  const change = (patch: Partial<BotAutomationDraft>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current))
    setError(null)
  }

  const save = async () => {
    if (!client || !saved || !draft) {
      return
    }
    if (!draft.prompt.trim()) {
      setError(t('automations.botTarget.promptMissing', 'Enter what it should do.'))
      return
    }
    const missing = draft.target ? missingBotResultsPlace(draft.target) : null
    if (missing) {
      setError(
        missing === 'channel'
          ? t('automations.botTarget.channelMissing', 'Enter the channel to send results to.')
          : t(
              'automations.botTarget.linearIssueInvalid',
              'Enter the Linear issue to send results to, like ENG-123.'
            )
      )
      return
    }
    setBusy(true)
    try {
      const { automation } = automationUpdateWrite.interpret(
        await automationUpdateWrite.request(
          client,
          {
            id: saved.id,
            updates: botAutomationUpdates(saved, draft, Date.now()),
            ...(expectedOwner ? { expectedOwner } : {})
          },
          { failWhenDisconnected: true }
        )
      )
      if (open.current) {
        props.onSaved(automation)
      }
    } catch (failure) {
      setError(automationErrorMessage(failure))
    } finally {
      setBusy(false)
    }
  }

  const header = (
    <SheetHeader
      title={t('automations.mobile.editAutomation', 'Edit automation')}
      subtitle={bot?.name}
      onBack={{
        label: t('automations.mobile.back', 'Back'),
        onPress: () => leave(props.onBack)
      }}
      trailing={{
        label: t('common.save', 'Save'),
        onPress: () => void save(),
        disabled: disabled || !changed || !draft?.name.trim(),
        busy
      }}
    />
  )

  if (!draft || !saved) {
    return (
      <View>
        {header}
        <View style={styles.content}>
          {error ? (
            <>
              <Text accessibilityRole="alert" style={automationStyles.error}>
                {error}
              </Text>
              <ListGroup>
                <ListRow
                  title={t('automations.mobile.refresh', 'Refresh')}
                  onPress={() => setReload((value) => value + 1)}
                />
              </ListGroup>
            </>
          ) : (
            <Text style={automationStyles.meta}>{t('automations.mobile.loading', 'Loading…')}</Text>
          )}
        </View>
      </View>
    )
  }

  const botLabel = (name: string) => t('automations.botTarget.option', 'Bot · {{name}}', { name })
  const pickBot = () =>
    props.present({
      kind: 'picker',
      title: t('automations.botTarget.fieldLabel', 'Bot or project'),
      options: props.bots.map((entry) => ({
        value: entry.id,
        label: botLabel(entry.name),
        renderIcon: () => <MobileBotAvatar avatar={mobileBotAvatarSource(entry)} size={24} />
      })),
      selected: target?.botId ?? '',
      onSelect: (botId) => {
        if (target && botId !== target.botId) {
          // Another agent brings its own agent and chats, so only where results go carries over.
          change({
            target: {
              botId,
              runsIn: target.runsIn,
              resultsTo: target.resultsTo,
              ...(target.letBotReact ? { letBotReact: true } : {})
            }
          })
        }
      }
    })
  const botRow = (
    <ListRow
      title={t('automations.botTarget.fieldLabel', 'Bot or project')}
      subtitle={bot ? bot.name : t('automations.botTarget.deletedBot', 'Deleted bot')}
      subtitleLines={1}
      accessibilityLabel={`${t('automations.botTarget.fieldLabel', 'Bot or project')}, ${
        bot ? bot.name : t('automations.botTarget.deletedBot', 'Deleted bot')
      }`}
      subtitleIcon={
        bot ? <MobileBotAvatar avatar={mobileBotAvatarSource(bot)} size={16} /> : undefined
      }
      // A saved automation moves only to another agent, never to a project.
      navigates={bot !== null && props.bots.length > 1}
      onPress={bot !== null && props.bots.length > 1 && !disabled ? pickBot : undefined}
    />
  )
  return (
    <View>
      {header}
      <View style={styles.content}>
        {error ? (
          <Text accessibilityRole="alert" style={automationStyles.error}>
            {error}
          </Text>
        ) : null}
        <SectionHeader title={t('automations.mobile.name', 'Name')} first />
        <FieldTextInput
          style={automationStyles.input}
          value={draft.name}
          onChangeText={(name) => change({ name })}
          editable={!disabled}
          accessibilityLabel={t('automations.mobile.name', 'Name')}
        />
        <SectionHeader title={t('automations.botTarget.prompt', 'What should it do?')} />
        <FieldTextInput
          style={[automationStyles.input, automationStyles.multiline]}
          value={draft.prompt}
          onChangeText={(prompt) => change({ prompt })}
          multiline
          editable={!disabled}
          accessibilityLabel={t('automations.botTarget.prompt', 'What should it do?')}
        />
        <SectionHeader title={t('automations.botTarget.when', 'When')} />
        <BotAutomationWhenRows
          draft={draft}
          hasEvents={events.length > 0}
          change={change}
          present={props.present}
          disabled={disabled}
          onSetUpEvents={
            askInChat
              ? () =>
                  leave(() =>
                    askInChat(
                      t(
                        'automations.botEvents.addDraft',
                        'Change the automation “{{name}}” so it also runs when ',
                        { name: saved.name }
                      )
                    )
                  )
              : null
          }
        />
        {events.length > 0 ? (
          <>
            <SectionHeader title={t('automations.botEvents.label', 'Events')} />
            <ListGroup>
              {[
                ...events.map((trigger) => (
                  <ListRow
                    key={trigger.id}
                    title={eventLabel(trigger)}
                    wrapTitle
                    leading={<Zap size={17} color={colors.statusAmber} strokeWidth={1.8} />}
                  />
                )),
                ...(askInChat
                  ? [
                      <ListRow
                        key="edit-in-chat"
                        title={t('automations.botEvents.editInChat', 'Edit in chat')}
                        accent
                        onPress={() =>
                          leave(() =>
                            askInChat(
                              t(
                                'automations.botEvents.editDraft',
                                'Change the automation “{{name}}”: ',
                                { name: saved.name }
                              )
                            )
                          )
                        }
                      />
                    ]
                  : [])
              ]}
            </ListGroup>
          </>
        ) : null}
        {target && bot ? (
          <BotAutomationTargetRows
            target={target}
            bot={bot}
            botRow={botRow}
            agents={agents}
            threadReplies={props.threadReplies}
            hasEventThread={botEventsHaveThreads(draft.eventsOnly, events)}
            present={props.present}
            disabled={disabled}
            onChange={(next) => change({ target: next })}
          />
        ) : (
          <>
            <SectionHeader title={t('automations.botTarget.runs', 'Runs')} />
            <ListGroup>{botRow}</ListGroup>
          </>
        )}
      </View>
    </View>
  )
}

const styles = themedStyleSheet(() => ({
  content: { gap: spacing.sm, paddingBottom: spacing.xl }
}))
