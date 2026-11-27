// The automation editor: one sheet like the agents' editor (Name, What should it do?, Where, When),
// with Advanced one page down. A detail row opens it on just its own section.
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../../src/shared/automations/automation-runtime-capabilities'
import { BottomDrawer, OptionPager, useOptionPager } from '../components/bottom-drawer/BottomDrawer'
import { FieldTextInput } from '../components/composer-input/FieldTextInput'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsNote } from '../settings/settings-screen-frame'
import { spacing } from '../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../theme/themed-styles'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { MobileNewTabAgentOption } from '../session/agent-launch/mobile-new-tab-agent-options'
import type { MobileAutomation } from './automation-reply-schema'
import {
  automationSetupKey,
  workspaceMatchesSetup,
  loadAutomationAgents,
  loadAutomationTargets,
  type AutomationTargets
} from './automation-target-inventory'
import {
  automationDraftEdits,
  newAutomationDraft,
  validateAutomationDraft,
  type AutomationDraft
} from './automation-draft'
import { useAutomationEditorDraft } from './use-automation-editor-draft'
import { useAutomationTargetDrafts } from './use-automation-target-drafts'
import { useAutomationLeaveGuard, type AutomationLeaveSlot } from './AutomationEditorNavigation'
import type { PresentAutomationSheet } from './AutomationSheets'
import { BotAutomationWhenRows } from './BotAutomationWhenRows'
import { AutomationWhereRows } from './AutomationWhereRows'
import { AutomationAdvancedRows, AutomationTimeZoneRow } from './AutomationAdvancedRows'
import { automationErrorMessage } from './automation-error'
import { automationStylesSheet } from './automation-styles'

/** Which part of the editor a detail row opens; none opens all of it. */
export type AutomationEditorSection = 'prompt' | 'where' | 'when'
const SECTION_FIELDS: Record<AutomationEditorSection, readonly string[]> = {
  prompt: ['prompt'],
  where: ['setupId', 'workspaceMode', 'workspaceId', 'agentId', 'reuseSession'],
  when: ['rrule', 'timezone']
}

export function AutomationEditor(props: {
  visible: boolean
  client: RpcClient
  current?: MobileAutomation
  section?: AutomationEditorSection
  initialDraft?: AutomationDraft
  /** Where unsaved edits are kept; they come back when this editor opens again, even after a kill. */
  draftKey: string
  onDraftChange: (draft: AutomationDraft) => void
  busy: boolean
  /** Why the last save failed, from the page's catalog. */
  saveError: string | null
  connected: boolean
  capabilities: readonly string[]
  present: PresentAutomationSheet
  onClose: () => void
  onAfterClose: () => void
  leaveGuard?: AutomationLeaveSlot
  onSave: (draft: AutomationDraft, original: AutomationDraft, targets: AutomationTargets) => void
}) {
  const t = useMobileTranslation()
  const styles = useThemedStyles(stylesSheet)
  const automationStyles = useThemedStyles(automationStylesSheet)
  const { present } = props
  const form = useAutomationEditorDraft(props.draftKey, props.current, props.initialDraft)
  const { draft, setDraft, original } = form
  // Unsaved edits restored from outside the row's section open the whole editor, so none hide.
  const requested = props.section
  const section =
    requested &&
    Object.keys(automationDraftEdits(original.current, draft) ?? {}).every(
      (field) => field.endsWith('Edited') || SECTION_FIELDS[requested].includes(field)
    )
      ? requested
      : undefined
  const leave = useAutomationLeaveGuard(draft, original, props.leaveGuard, form.discard, present)
  const selectTargetDraft = useAutomationTargetDrafts()
  const pager = useOptionPager<'advanced'>()
  const initialized = useRef(false)
  const [targets, setTargets] = useState<AutomationTargets | null>(null)
  const [agents, setAgents] = useState<MobileNewTabAgentOption[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inventoryLimit, setInventoryLimit] = useState(200)
  const [reload, setReload] = useState(0)
  const [agentReload, setAgentReload] = useState(0)
  const disabled = props.busy || !props.connected || !targets
  const setup = targets?.setups.find((entry) => automationSetupKey(entry) === draft.setupId)
  const workspaces =
    targets?.workspaces.filter((workspace) => setup && workspaceMatchesSetup(workspace, setup)) ??
    []

  useEffect(() => {
    if (!props.connected) {
      return
    }
    let active = true
    const generation = props.client.getGeneration?.()
    void loadAutomationTargets(props.client, inventoryLimit)
      .then((next) => {
        if (!active || generation !== props.client.getGeneration?.()) {
          return
        }
        setTargets(next)
        setError(null)
        if (!initialized.current) {
          initialized.current = true
          const initial = newAutomationDraft(props.current)
          const target =
            next.setups.find((entry) => automationSetupKey(entry) === initial.setupId) ??
            (props.current
              ? !props.current.runContext &&
                next.setups.filter((entry) => entry.repoId === props.current?.projectId).length ===
                  1
                ? next.setups.find((entry) => entry.repoId === props.current?.projectId)
                : undefined
              : next.setups.find((entry) => !entry.hostId.startsWith('runtime:')))
          initial.setupId = target ? automationSetupKey(target) : initial.setupId
          if (!props.current && target?.kind === 'folder') {
            initial.workspaceMode = 'existing'
          }
          original.current = { ...initial }
          setDraft(props.initialDraft ?? form.withSavedEdits(initial))
        }
      })
      .catch((failure: unknown) => {
        if (active && generation === props.client.getGeneration?.()) {
          setError(automationErrorMessage(failure, translate))
        }
      })
    return () => {
      active = false
    }
  }, [props.client, props.connected, props.current, reload, inventoryLimit])

  useEffect(() => {
    if (!setup || !props.connected) {
      setAgentsLoading(false)
      setAgents([])
      setAgentError(null)
      return
    }
    let active = true
    const generation = props.client.getGeneration?.()
    setAgentsLoading(true)
    setAgents([])
    setAgentError(null)
    void loadAutomationAgents(
      props.client,
      setup,
      draft.workspaceMode === 'existing' ? draft.workspaceId || undefined : undefined
    )
      .then((options) => {
        if (!active || generation !== props.client.getGeneration?.()) {
          return
        }
        setAgents(options)
        const agentId = options[0]?.agent ?? null
        // The default agent is part of the untouched form, not an edit to ask about.
        original.current.agentId ??= agentId
        setDraft((current) => (current.agentId ? current : { ...current, agentId }))
      })
      .catch((failure: unknown) => {
        if (active && generation === props.client.getGeneration?.()) {
          setAgents([])
          setAgentError(automationErrorMessage(failure, translate))
        }
      })
      .finally(() => {
        if (active && generation === props.client.getGeneration?.()) {
          setAgentsLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [props.client, props.connected, setup, draft.workspaceMode, draft.workspaceId, agentReload])

  useEffect(() => {
    props.onDraftChange(draft)
  }, [draft, props.onDraftChange])

  function change(patch: Partial<AutomationDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
    setError(null)
  }
  function changeTarget(patch: Partial<AutomationDraft>) {
    setDraft((current) => selectTargetDraft(current, patch))
    setError(null)
  }
  const ready =
    targets !== null &&
    !agentsLoading &&
    draft.name.trim() !== '' &&
    draft.prompt.trim() !== '' &&
    draft.agentId !== null &&
    (draft.workspaceMode !== 'existing' || draft.workspaceId !== '') &&
    (props.current !== undefined || setup !== undefined)
  function submit() {
    const validation = validateAutomationDraft(draft, 3, props.current)
    if (validation) {
      setError(validation)
      return
    }
    if (targets) {
      props.onSave(draft, original.current, targets)
    }
  }

  const whereRows = (
    <AutomationWhereRows
      draft={draft}
      current={props.current}
      targets={targets}
      setup={setup}
      workspaces={workspaces}
      agents={agents}
      agentsLoading={agentsLoading}
      disabled={disabled}
      present={present}
      change={change}
      changeTarget={changeTarget}
      onLoadMore={() =>
        setInventoryLimit(Math.max(inventoryLimit + 200, targets?.coverage.totalCount ?? 0))
      }
    />
  )
  const noAgents = !agentsLoading && !agentError && setup && agents.length === 0 && !props.current
  // A failed save lands in the page's notes, which the sheet covers.
  const note = error ?? agentError ?? props.saveError
  const main = (
    <View>
      <SheetHeader
        title={
          section === 'prompt'
            ? t('automations.mobile.instructions', 'Instructions')
            : section === 'where'
              ? t('automations.mobile.where', 'Where')
              : section === 'when'
                ? t('automations.mobile.schedule', 'Schedule')
                : props.current
                  ? t('automations.mobile.editAutomation', 'Edit automation')
                  : t('automations.mobile.newAutomation', 'New automation')
        }
        subtitle={section ? props.current?.name : undefined}
        leading={{
          label: t('automations.mobile.cancel', 'Cancel'),
          onPress: () => leave.guard(props.onClose),
          disabled: props.busy
        }}
        trailing={{
          label: props.current ? t('common.save', 'Save') : t('automations.mobile.add', 'Add'),
          onPress: submit,
          disabled: !ready || !props.connected || (props.current !== undefined && !leave.changed),
          busy: props.busy
        }}
      />
      <View style={[styles.content, section && styles.sectionOnly]}>
        {note ? <SettingsNote error>{note}</SettingsNote> : null}
        {(error && !targets) || agentError ? (
          <ListGroup>
            <ListRow
              title={t('automations.mobile.refresh', 'Refresh')}
              accent
              disabled={props.busy || !props.connected}
              onPress={() =>
                error && !targets
                  ? setReload((value) => value + 1)
                  : setAgentReload((value) => value + 1)
              }
            />
          </ListGroup>
        ) : null}
        {section === undefined ? (
          <>
            <SectionHeader title={t('automations.mobile.name', 'Name')} first />
            <FieldTextInput
              style={automationStyles.input}
              value={draft.name}
              onChangeText={(name) => change({ name })}
              editable={!disabled}
              accessibilityLabel={t('automations.mobile.name', 'Name')}
            />
          </>
        ) : null}
        {section === undefined || section === 'prompt' ? (
          <>
            {section === undefined ? (
              <SectionHeader title={t('automations.botTarget.prompt', 'What should it do?')} />
            ) : null}
            <FieldTextInput
              style={[automationStyles.input, automationStyles.multiline]}
              value={draft.prompt}
              onChangeText={(prompt) => change({ prompt })}
              multiline
              editable={!disabled}
              accessibilityLabel={t('automations.botTarget.prompt', 'What should it do?')}
            />
          </>
        ) : null}
        {section === undefined || section === 'where' ? (
          <>
            {section === undefined ? (
              <SectionHeader title={t('automations.mobile.where', 'Where')} />
            ) : null}
            {whereRows}
            {noAgents ? (
              <SettingsNote>
                {t(
                  'automations.mobile.installAndEnableAnAgentOnThisHostThenRetry',
                  'Install and enable an agent on this host, then retry.'
                )}
              </SettingsNote>
            ) : null}
          </>
        ) : null}
        {section === undefined || section === 'when' ? (
          <>
            {section === undefined ? (
              <SectionHeader title={t('automations.botTarget.when', 'When')} />
            ) : null}
            <BotAutomationWhenRows
              draft={{ eventsOnly: false, rrule: draft.rrule }}
              hasEvents={false}
              change={(patch) =>
                patch.rrule === undefined ? undefined : change({ rrule: patch.rrule })
              }
              onSetUpEvents={null}
              present={present}
              disabled={disabled}
            />
            {section === 'when' ? (
              <ListGroup style={styles.advanced}>
                <AutomationTimeZoneRow
                  draft={draft}
                  change={change}
                  present={present}
                  disabled={disabled}
                />
              </ListGroup>
            ) : null}
          </>
        ) : null}
        {section === undefined ? (
          <ListGroup style={styles.advanced}>
            <ListRow
              title={t('automations.mobile.advanced', 'Advanced')}
              navigates
              disabled={disabled}
              onPress={() => pager.open('advanced')}
            />
          </ListGroup>
        ) : null}
      </View>
    </View>
  )
  const page =
    pager.page === 'advanced' ? (
      <View>
        <SheetHeader
          title={t('automations.mobile.advanced', 'Advanced')}
          onBack={{ label: t('automations.mobile.back', 'Back'), onPress: pager.close }}
        />
        <AutomationAdvancedRows
          draft={draft}
          change={change}
          present={present}
          disabled={disabled}
          extraArgs={props.capabilities.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)}
        />
      </View>
    ) : null
  return (
    <BottomDrawer
      visible={props.visible}
      // With unsaved edits only Cancel closes it, so a create the host may have made can't be
      // reopened as a fresh attempt.
      dismissible={!props.busy && !leave.changed}
      onClose={props.onClose}
      onAfterClose={() => {
        pager.forget()
        props.onAfterClose()
      }}
    >
      <OptionPager pager={pager} main={main} page={page} />
    </BottomDrawer>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  content: { gap: spacing.sm, paddingBottom: spacing.xl },
  sectionOnly: { paddingTop: spacing.xs },
  advanced: { marginTop: spacing.sm }
}))
