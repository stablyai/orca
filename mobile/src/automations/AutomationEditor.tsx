import { AutomationDraftReview } from './AutomationDraftReview'
import { AutomationEditorHeader, AutomationEditorNavigation } from './AutomationEditorNavigation'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useEffect, useRef, useState } from 'react'
import { useAutomationTargetDrafts } from './use-automation-target-drafts'
import { Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileAutomation } from './automation-reply-schema'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import type { MobileNewTabAgentOption } from '../session/mobile-new-tab-agent-options'
import { AutomationAdvancedFields } from './AutomationAdvancedFields'
import { AutomationButton, AutomationChoice, AutomationField } from './AutomationControls'
import { AutomationScheduleFields } from './AutomationScheduleFields'
import {
  automationSetupKey,
  workspaceMatchesSetup,
  loadAutomationAgents,
  loadAutomationTargets,
  type AutomationTargets
} from './automation-target-inventory'
import {
  newAutomationDraft,
  validateAutomationDraft,
  type AutomationDraft
} from './automation-draft'
import { automationErrorMessage } from './automation-error'
import { automationStyles as styles } from './automation-styles'

export function AutomationEditor(props: {
  client: RpcClient
  current?: MobileAutomation
  initialDraft?: AutomationDraft
  onDraftChange: (draft: AutomationDraft) => void
  busy: boolean
  connected: boolean
  capabilities: readonly string[]
  onCancel: () => void
  onSave: (draft: AutomationDraft, original: AutomationDraft, targets: AutomationTargets) => void
}) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const [draft, setDraft] = useState(() => props.initialDraft ?? newAutomationDraft(props.current))
  const original = useRef(newAutomationDraft(props.current))
  const selectTargetDraft = useAutomationTargetDrafts()
  const initialized = useRef(false)
  const [targets, setTargets] = useState<AutomationTargets | null>(null)
  const [agents, setAgents] = useState<MobileNewTabAgentOption[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [step, setStep] = useState(props.initialDraft ? 3 : 1)
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [inventoryLimit, setInventoryLimit] = useState(200)
  const [reload, setReload] = useState(0)
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
          setDraft(props.initialDraft ?? initial)
        }
      })
      .catch((failure: unknown) => {
        if (active && generation === props.client.getGeneration?.()) {
          setError(automationErrorMessage(failure))
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
        setDraft((current) =>
          current.agentId ? current : { ...current, agentId: options[0]?.agent ?? null }
        )
      })
      .catch((failure: unknown) => {
        if (active && generation === props.client.getGeneration?.()) {
          setAgents([])
          setAgentError(automationErrorMessage(failure))
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
  }, [props.client, props.connected, setup, draft.workspaceMode, draft.workspaceId])

  useEffect(() => {
    props.onDraftChange(draft)
  }, [draft, props.onDraftChange])

  const agentOptions = agents.map((option) => ({ value: option.agent, label: option.label }))
  if (draft.agentId && !agentOptions.some((option) => option.value === draft.agentId)) {
    agentOptions.unshift({
      value: draft.agentId,
      label: t('automations.mobile.savedAgent', '{{agent}} (saved)', {
        agent: MOBILE_TUI_AGENT_LABELS[draft.agentId]
      })
    })
  }
  function change(patch: Partial<AutomationDraft>) {
    setDraft((current) => ({
      ...current,
      ...patch,
      ...('setupId' in patch || 'workspaceMode' in patch || 'workspaceId' in patch
        ? { targetEdited: true }
        : {})
    }))
    setError(null)
  }
  function changeTarget(patch: Partial<AutomationDraft>) {
    setDraft((current) => {
      return selectTargetDraft(current, patch)
    })
    setError(null)
  }
  function next() {
    const validation = validateAutomationDraft(draft, step, props.current)
    if (validation) {
      setError(validation)
      return
    }
    if (!targets || (!props.current && !setup)) {
      setError(
        t(
          'automations.mobile.chooseAProjectSetUpOnThisHost',
          'Choose a project set up on this host.'
        )
      )
      return
    }
    if (step < 3) {
      setStep(step + 1)
    } else {
      props.onSave(draft, original.current, targets)
    }
  }
  return (
    <View style={styles.stack}>
      <AutomationEditorHeader
        step={step}
        editing={!!props.current}
        busy={props.busy}
        onCancel={props.onCancel}
      />
      {error || agentError ? (
        <View style={styles.stack}>
          <Text accessibilityRole="alert" style={styles.error}>
            {error ?? agentError}
          </Text>
          {!targets ? (
            <AutomationButton
              label={t('automations.mobile.retryProjectLoading', 'Retry project loading')}
              onPress={() => setReload((value) => value + 1)}
              disabled={props.busy || !props.connected}
            />
          ) : null}
        </View>
      ) : null}
      {!targets && !error ? (
        <Text style={styles.meta}>
          {t('automations.mobile.loadingProjects', 'Loading projects…')}
        </Text>
      ) : null}
      {step === 1 ? (
        <>
          <AutomationField
            label={t('automations.mobile.name', 'Name')}
            value={draft.name}
            onChange={(name) => change({ name })}
            disabled={disabled}
          />
          <AutomationField
            label={t('automations.mobile.instructions', 'Instructions')}
            value={draft.prompt}
            onChange={(prompt) => change({ prompt })}
            multiline
            disabled={disabled}
          />
          <AutomationChoice
            label={t('automations.mobile.projectAndHostSetup', 'Project and host setup')}
            value={draft.setupId}
            options={[
              ...(targets?.setups
                .filter((entry) => !entry.hostId.startsWith('runtime:'))
                .map((entry) => ({
                  value: automationSetupKey(entry),
                  label: entry.label,
                  subtitle: `${entry.displayName} · ${entry.path}`
                })) ?? []),
              ...(!setup && props.current
                ? [
                    {
                      value: draft.setupId,
                      label: t('automations.mobile.savedTarget', 'Saved target'),
                      subtitle: props.current.runContext?.path ?? props.current.projectId
                    }
                  ]
                : [])
            ]}
            disabled={disabled || !targets}
            onSelect={(setupId) => {
              const target = targets?.setups.find((entry) => automationSetupKey(entry) === setupId)
              changeTarget({
                setupId,
                workspaceId: '',
                workspaceMode: target?.kind === 'folder' ? 'existing' : draft.workspaceMode,
                reuseSession: false,
                agentId: null
              })
            }}
          />
          <AutomationChoice
            label={t('automations.mobile.workspace', 'Workspace')}
            value={draft.workspaceMode}
            options={[
              {
                value: 'new_per_run',
                label: t('automations.mobile.newWorkspacePerRun', 'New workspace per run'),
                disabled: setup?.kind === 'folder'
              },
              {
                value: 'existing',
                label: t('automations.mobile.useAnExistingWorkspace', 'Use an existing workspace')
              }
            ]}
            onSelect={(workspaceMode) => changeTarget({ workspaceMode, reuseSession: false })}
            disabled={disabled}
          />
          {draft.workspaceMode === 'existing' ? (
            <AutomationChoice
              label={t('automations.mobile.existingWorkspace', 'Existing workspace')}
              value={draft.workspaceId}
              options={[
                ...workspaces.map((workspace) => ({
                  value: workspace.worktreeId,
                  label: workspace.displayName || workspace.path,
                  subtitle: workspace.path
                })),
                ...(props.current &&
                draft.workspaceId &&
                !workspaces.some((workspace) => workspace.worktreeId === draft.workspaceId)
                  ? [
                      {
                        value: draft.workspaceId,
                        label: t('automations.mobile.savedWorkspace', 'Saved workspace'),
                        subtitle: draft.workspaceId
                      }
                    ]
                  : [])
              ]}
              onSelect={(workspaceId) =>
                changeTarget({ workspaceId, agentId: props.current?.agentId ?? null })
              }
              disabled={disabled || !targets}
            />
          ) : null}
          {targets?.coverage.truncated ? (
            <AutomationButton
              label={t('automations.mobile.loadMoreWorkspaces', 'Load more workspaces')}
              onPress={() =>
                setInventoryLimit(Math.max(inventoryLimit + 200, targets.coverage.totalCount))
              }
              disabled={props.busy || !props.connected}
            />
          ) : null}
          {setup && targets?.coverage.hostScope.omittedHostIds.includes(setup.hostId) ? (
            <Text style={styles.meta}>
              {t(
                'automations.mobile.thisHostSWorkspaceInventoryIsIncompleteRefreshOrLoadMoreWorkspaces',
                'This host’s workspace inventory is incomplete. Refresh or load more workspaces.'
              )}
            </Text>
          ) : null}
          <AutomationChoice
            label={
              agentsLoading
                ? t('automations.mobile.agentDetecting', 'Agent · detecting…')
                : t('automations.mobile.agent', 'Agent')
            }
            value={draft.agentId ?? ''}
            options={agentOptions}
            onSelect={(value) => {
              const agent = agentOptions.find((option) => option.value === value)
              if (agent) {
                change({ agentId: agent.value })
              }
            }}
            disabled={disabled || agentsLoading}
          />
          {!agentsLoading && !agentError && setup && agents.length === 0 && !props.current ? (
            <Text style={styles.meta}>
              {t(
                'automations.mobile.installAndEnableAnAgentOnThisHostThenRetry',
                'Install and enable an agent on this host, then retry.'
              )}
            </Text>
          ) : null}
          <AutomationButton
            label={
              advanced
                ? t('automations.mobile.hideAdvancedOptions', 'Hide advanced options')
                : t('automations.mobile.advancedOptions', 'Advanced options')
            }
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced ? (
            <AutomationAdvancedFields
              draft={draft}
              change={change}
              disabled={disabled}
              capabilities={props.capabilities}
            />
          ) : null}
        </>
      ) : step === 2 ? (
        <AutomationScheduleFields draft={draft} change={change} disabled={disabled} />
      ) : (
        <AutomationDraftReview draft={draft} setup={setup} workspaces={workspaces} />
      )}
      <AutomationEditorNavigation
        step={step}
        editing={!!props.current}
        busy={props.busy}
        disabled={disabled || !targets || agentsLoading}
        onBack={() => setStep(step - 1)}
        onNext={next}
      />
    </View>
  )
}
