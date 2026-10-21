import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import type { MobileAutomation } from './automation-reply-schema'
import type { AutomationTargets } from './automation-target-inventory'
import { automationTargetContext, automationTargetDestination } from './automation-target-inventory'
import { isValidAutomationSchedule } from '../../../src/shared/automation-schedule-parsing'
import { MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS } from '../../../src/shared/automation-precheck'

export type AutomationDraft = {
  name: string
  prompt: string
  agentId: TuiAgent | null
  setupId: string
  workspaceId: string
  workspaceMode: 'existing' | 'new_per_run'
  rrule: string
  timezone: string
  baseBranch: string
  setupDecision: 'inherit' | 'run' | 'skip'
  reuseSession: boolean
  extraAgentArgs: string
  precheckCommand: string
  precheckTimeout: string
  grace: string
}

export function newAutomationDraft(current?: MobileAutomation): AutomationDraft {
  return {
    name: current?.name ?? '',
    prompt: current?.prompt ?? '',
    agentId: current?.agentId ?? null,
    setupId: current?.runContext?.projectHostSetupId ?? '',
    workspaceId: current?.workspaceId ?? '',
    workspaceMode: current?.workspaceMode ?? 'new_per_run',
    rrule: current?.rrule ?? '0 9 * * 1-5',
    timezone: current?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    baseBranch: current?.baseBranch ?? '',
    setupDecision: current?.setupDecision ?? 'inherit',
    reuseSession: current?.reuseSession ?? false,
    extraAgentArgs: current?.extraAgentArgs ?? '',
    precheckCommand: current?.precheck?.command ?? '',
    precheckTimeout: String(current?.precheck?.timeoutSeconds ?? 60),
    grace: String(current?.missedRunGraceMinutes ?? 720)
  }
}

export function validateAutomationDraft(draft: AutomationDraft, step: number): string | null {
  if (!draft.name.trim() || !draft.prompt.trim() || !draft.agentId) {
    return 'Add a name, instructions and an agent.'
  }
  if (draft.workspaceMode === 'existing' && !draft.workspaceId) {
    return 'Choose an existing workspace.'
  }
  if (step < 2) {
    return null
  }
  if (!isValidAutomationSchedule(draft.rrule)) {
    return 'Enter a valid cron or RRULE schedule.'
  }
  try {
    new Intl.DateTimeFormat('en', { timeZone: draft.timezone }).format()
  } catch {
    return 'Enter a valid time zone, such as America/Los_Angeles.'
  }
  if (!Number.isInteger(Number(draft.grace)) || Number(draft.grace) < 0) {
    return 'Missed-run grace must be zero or a positive number of minutes.'
  }
  if (
    draft.precheckCommand.trim() &&
    (!Number.isInteger(Number(draft.precheckTimeout)) ||
      Number(draft.precheckTimeout) < 1 ||
      Number(draft.precheckTimeout) > MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS)
  ) {
    return `Precheck timeout must be between 1 and ${MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS} seconds.`
  }
  return null
}

type UpdateFields = RpcSendParams<'automation.update'>['updates']
function editableFields(draft: AutomationDraft): UpdateFields {
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    ...(draft.agentId ? { agentId: draft.agentId } : {}),
    rrule: draft.rrule,
    timezone: draft.timezone,
    baseBranch: draft.baseBranch || null,
    setupDecision: draft.setupDecision,
    reuseSession: draft.workspaceMode === 'existing' && draft.reuseSession,
    extraAgentArgs: draft.extraAgentArgs,
    precheck: draft.precheckCommand.trim()
      ? { command: draft.precheckCommand, timeoutSeconds: Number(draft.precheckTimeout) }
      : null,
    missedRunGraceMinutes: Number(draft.grace)
  }
}

export function automationDraftPatch(
  draft: AutomationDraft,
  original: AutomationDraft
): UpdateFields {
  const fields = editableFields(draft)
  const before = editableFields(original)
  const patch: UpdateFields = {}
  for (const key of [
    'name',
    'prompt',
    'agentId',
    'rrule',
    'timezone',
    'baseBranch',
    'setupDecision',
    'reuseSession',
    'extraAgentArgs',
    'precheck',
    'missedRunGraceMinutes'
  ] as const) {
    if (fields[key] !== before[key]) {
      if (
        key === 'precheck' &&
        JSON.stringify(fields.precheck) === JSON.stringify(before.precheck)
      ) {
        continue
      }
      Object.assign(patch, { [key]: fields[key] })
    }
  }
  return patch
}

export function automationCreateParams(
  draft: AutomationDraft,
  targets: AutomationTargets,
  creationKey?: string
): RpcSendParams<'automation.create'> {
  const setup = targets.setups.find((entry) => entry.id === draft.setupId)
  if (!setup || !draft.agentId) {
    throw new Error('Choose a project and agent on this host.')
  }
  const workspace = targets.workspaces.find(
    (entry) => entry.worktreeId === draft.workspaceId && entry.repoId === setup.repoId
  )
  if (draft.workspaceMode === 'existing' && !workspace) {
    throw new Error('Choose an existing workspace in this project.')
  }
  if (setup.kind === 'folder' && draft.workspaceMode !== 'existing') {
    throw new Error('Folder projects require an existing workspace.')
  }
  return {
    ...editableFields(draft),
    baseBranch: draft.baseBranch || undefined,
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    agentId: draft.agentId,
    creationKey,
    repo: `id:${setup.repoId}`,
    workspaceMode: draft.workspaceMode,
    ...(draft.workspaceMode === 'existing' && workspace
      ? { workspace: `id:${workspace.worktreeId}` }
      : {}),
    runContext: automationTargetContext(setup),
    destination: automationTargetDestination(
      setup,
      draft.workspaceMode === 'existing' ? workspace : undefined,
      targets
    ),
    rrule: draft.rrule,
    dtstart: Date.now(),
    enabled: true,
    timezone: draft.timezone
  }
}

export function automationUpdateParams(
  id: string,
  draft: AutomationDraft,
  original: AutomationDraft,
  targets: AutomationTargets
): Pick<RpcSendParams<'automation.update'>, 'id' | 'updates' | 'destination'> {
  const updates = automationDraftPatch(draft, original)
  if (
    draft.setupId === original.setupId &&
    draft.workspaceMode === original.workspaceMode &&
    draft.workspaceId === original.workspaceId
  ) {
    return { id, updates }
  }
  const target = automationCreateParams(draft, targets, '')
  return {
    id,
    destination: target.destination,
    updates: {
      ...updates,
      repo: target.repo,
      workspace: target.workspace,
      workspaceMode: target.workspaceMode,
      runContext: target.runContext
    }
  }
}
