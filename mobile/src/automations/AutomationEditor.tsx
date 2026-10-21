import { useEffect, useRef, useState } from 'react'
import { Switch, Text, View } from 'react-native'
import type { RpcClient } from '../transport/rpc-client'
import type { MobileAutomation } from './automation-reply-schema'
import { MOBILE_TUI_AGENT_LABELS } from '../tasks/mobile-tui-agents'
import type { MobileNewTabAgentOption } from '../session/mobile-new-tab-agent-options'
import { AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY } from '../../../src/shared/automation-runtime-capabilities'
import { formatAutomationSchedule } from '../../../src/shared/automation-schedules'
import {
  AutomationButton,
  AutomationChoice,
  AutomationField,
  AutomationMetadata
} from './AutomationControls'
import { AutomationScheduleFields } from './AutomationScheduleFields'
import {
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
  busy: boolean
  connected: boolean
  capabilities: readonly string[]
  onCancel: () => void
  onSave: (draft: AutomationDraft, original: AutomationDraft, targets: AutomationTargets) => void
}) {
  const [draft, setDraft] = useState(() => newAutomationDraft(props.current))
  const original = useRef(newAutomationDraft(props.current))
  const initialized = useRef(false)
  const [targets, setTargets] = useState<AutomationTargets | null>(null)
  const [agents, setAgents] = useState<MobileNewTabAgentOption[]>([])
  const [agentsLoading, setAgentsLoading] = useState(true)
  const [step, setStep] = useState(1)
  const [advanced, setAdvanced] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const disabled = props.busy || !props.connected
  const setup = targets?.setups.find((entry) => entry.id === draft.setupId)
  const workspaces =
    targets?.workspaces.filter((workspace) => workspace.repoId === setup?.repoId) ?? []

  useEffect(() => {
    if (!props.connected) {
      return
    }
    let active = true
    const generation = props.client.getGeneration?.()
    void loadAutomationTargets(props.client)
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
            next.setups.find((entry) => entry.id === initial.setupId) ??
            (props.current
              ? next.setups.find((entry) => entry.repoId === props.current?.projectId)
              : next.setups.find((entry) => !entry.hostId.startsWith('runtime:')))
          initial.setupId = target?.id ?? initial.setupId
          if (!props.current && target?.kind === 'folder') {
            initial.workspaceMode = 'existing'
          }
          original.current = { ...initial }
          setDraft(initial)
        }
      })
      .catch((failure: unknown) => {
        if (active) {
          setError(automationErrorMessage(failure))
        }
      })
    return () => {
      active = false
    }
  }, [props.client, props.connected, props.current, reload])

  useEffect(() => {
    if (!setup || !props.connected) {
      setAgentsLoading(false)
      return
    }
    let active = true
    const generation = props.client.getGeneration?.()
    setAgentsLoading(true)
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
        if (active) {
          setAgents([])
          setError(automationErrorMessage(failure))
        }
      })
      .finally(() => {
        if (active) {
          setAgentsLoading(false)
        }
      })
    return () => {
      active = false
    }
  }, [props.client, props.connected, setup, draft.workspaceMode, draft.workspaceId])

  const agentOptions = agents.map((option) => ({ value: option.agent, label: option.label }))
  if (draft.agentId && !agentOptions.some((option) => option.value === draft.agentId)) {
    agentOptions.unshift({
      value: draft.agentId,
      label: `${MOBILE_TUI_AGENT_LABELS[draft.agentId]} (saved)`
    })
  }
  function change(patch: Partial<AutomationDraft>) {
    setDraft((current) => ({ ...current, ...patch }))
    setError(null)
  }
  function next() {
    const validation = validateAutomationDraft(draft, step)
    if (validation) {
      setError(validation)
      return
    }
    if (!targets || (!props.current && !setup)) {
      setError('Choose a project set up on this host.')
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
      <View style={styles.row}>
        <Text style={[styles.title, styles.grow]}>
          {props.current ? 'Edit automation' : 'New automation'}
        </Text>
        <AutomationButton label="Cancel" onPress={props.onCancel} disabled={props.busy} />
      </View>
      <Text style={styles.meta}>
        {step} of 3 · {step === 1 ? 'Task' : step === 2 ? 'Schedule' : 'Review'}
      </Text>
      {error ? (
        <View style={styles.stack}>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          {!targets ? (
            <AutomationButton
              label="Retry project loading"
              onPress={() => setReload((value) => value + 1)}
              disabled={disabled}
            />
          ) : null}
        </View>
      ) : null}
      {!targets && !error ? <Text style={styles.meta}>Loading projects…</Text> : null}
      {step === 1 ? (
        <>
          <AutomationField
            label="Name"
            value={draft.name}
            onChange={(name) => change({ name })}
            disabled={disabled}
          />
          <AutomationField
            label="Instructions"
            value={draft.prompt}
            onChange={(prompt) => change({ prompt })}
            multiline
            disabled={disabled}
          />
          <AutomationChoice
            label="Project and host setup"
            value={draft.setupId}
            options={[
              ...(targets?.setups
                .filter((entry) => !entry.hostId.startsWith('runtime:'))
                .map((entry) => ({
                  value: entry.id,
                  label: entry.label,
                  subtitle: `${entry.displayName} · ${entry.path}`
                })) ?? []),
              ...(!setup && props.current
                ? [
                    {
                      value: draft.setupId,
                      label: 'Saved target',
                      subtitle: props.current.runContext?.path ?? props.current.projectId
                    }
                  ]
                : [])
            ]}
            disabled={disabled || !targets}
            onSelect={(setupId) => {
              const target = targets?.setups.find((entry) => entry.id === setupId)
              change({
                setupId,
                workspaceId: '',
                workspaceMode: target?.kind === 'folder' ? 'existing' : draft.workspaceMode,
                reuseSession: false,
                agentId: null
              })
            }}
          />
          <AutomationChoice
            label="Workspace"
            value={draft.workspaceMode}
            options={[
              {
                value: 'new_per_run',
                label: 'New workspace per run',
                disabled: setup?.kind === 'folder'
              },
              { value: 'existing', label: 'Use an existing workspace' }
            ]}
            onSelect={(workspaceMode) => change({ workspaceMode, reuseSession: false })}
            disabled={disabled}
          />
          {draft.workspaceMode === 'existing' ? (
            <AutomationChoice
              label="Existing workspace"
              value={draft.workspaceId}
              options={workspaces.map((workspace) => ({
                value: workspace.worktreeId,
                label: workspace.displayName || workspace.path,
                subtitle: workspace.path
              }))}
              onSelect={(workspaceId) =>
                change({ workspaceId, agentId: props.current?.agentId ?? null })
              }
              disabled={disabled || !targets}
            />
          ) : null}
          <AutomationChoice
            label={agentsLoading ? 'Agent · detecting…' : 'Agent'}
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
          {!agentsLoading && agents.length === 0 && !props.current ? (
            <Text style={styles.meta}>Install and enable an agent on this host, then retry.</Text>
          ) : null}
          <AutomationButton
            label={advanced ? 'Hide advanced options' : 'Advanced options'}
            onPress={() => setAdvanced(!advanced)}
          />
          {advanced ? (
            <View style={styles.stack}>
              {draft.workspaceMode === 'new_per_run' ? (
                <AutomationField
                  label="Base branch (optional)"
                  value={draft.baseBranch}
                  onChange={(baseBranch) => change({ baseBranch })}
                  disabled={disabled}
                />
              ) : null}
              <AutomationChoice
                label="Workspace setup script"
                value={draft.setupDecision}
                options={[
                  { value: 'inherit', label: 'Use project settings' },
                  { value: 'run', label: 'Run setup script' },
                  { value: 'skip', label: 'Skip setup script' }
                ]}
                onSelect={(setupDecision) => change({ setupDecision })}
                disabled={disabled}
              />
              {draft.workspaceMode === 'existing' ? (
                <View style={styles.row}>
                  <Text style={[styles.text, styles.grow]}>Reuse agent session</Text>
                  <Switch
                    accessibilityLabel="Reuse agent session"
                    value={draft.reuseSession}
                    onValueChange={(reuseSession) => change({ reuseSession })}
                    disabled={disabled}
                  />
                </View>
              ) : null}
              <AutomationField
                label="Extra agent arguments"
                value={draft.extraAgentArgs}
                onChange={(extraAgentArgs) => change({ extraAgentArgs })}
                disabled={
                  disabled ||
                  !props.capabilities.includes(AUTOMATION_EXTRA_AGENT_ARGS_RUNTIME_CAPABILITY)
                }
              />
              <AutomationField
                label="Precheck command (optional)"
                value={draft.precheckCommand}
                onChange={(precheckCommand) => change({ precheckCommand })}
                disabled={disabled}
              />
              {draft.precheckCommand ? (
                <AutomationField
                  label="Precheck timeout (seconds)"
                  value={draft.precheckTimeout}
                  onChange={(precheckTimeout) => change({ precheckTimeout })}
                  numeric
                  disabled={disabled}
                />
              ) : null}
              <AutomationField
                label="Missed-run grace (minutes)"
                value={draft.grace}
                onChange={(grace) => change({ grace })}
                numeric
                disabled={disabled}
              />
            </View>
          ) : null}
        </>
      ) : step === 2 ? (
        <AutomationScheduleFields draft={draft} change={change} disabled={disabled} />
      ) : (
        <View style={styles.card}>
          <Text style={styles.title}>{draft.name}</Text>
          <AutomationMetadata label="Instructions" value={draft.prompt} />
          <AutomationMetadata
            label="Agent"
            value={draft.agentId ? MOBILE_TUI_AGENT_LABELS[draft.agentId] : 'Choose an agent'}
          />
          <AutomationMetadata
            label="Project"
            value={setup ? `${setup.label} · ${setup.path}` : 'Saved target'}
          />
          <AutomationMetadata
            label="Workspace"
            value={
              draft.workspaceMode === 'existing'
                ? (workspaces.find((entry) => entry.worktreeId === draft.workspaceId)
                    ?.displayName ?? draft.workspaceId)
                : 'New workspace per run'
            }
          />
          <AutomationMetadata
            label="Schedule"
            value={`${formatAutomationSchedule(draft.rrule)} · ${draft.timezone}`}
          />
        </View>
      )}
      <View style={styles.row}>
        {step > 1 ? (
          <AutomationButton label="Back" onPress={() => setStep(step - 1)} disabled={props.busy} />
        ) : null}
        <View style={styles.grow}>
          <AutomationButton
            label={step < 3 ? 'Continue' : props.current ? 'Save changes' : 'Create automation'}
            primary
            onPress={next}
            disabled={disabled || !targets || agentsLoading}
          />
        </View>
      </View>
    </View>
  )
}
