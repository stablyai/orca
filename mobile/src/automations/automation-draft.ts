import { translate } from '../i18n/mobile-i18n'
import { assertAutomationExtraAgentArgs } from '../../../src/shared/automation-extra-agent-args-record'
import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcSendParams } from '../transport/rpc-params-contract'
import type { MobileAutomation } from './automation-reply-schema'
import type { AutomationTargets } from './automation-target-inventory'
import { AutomationDraftValidationError } from './automation-error'
import {
  automationTargetContext,
  automationTargetDestination,
  automationSetupKey,
  workspaceMatchesSetup
} from './automation-target-inventory'
import { acceptsAutomationDraftSchedule } from '../../../src/shared/automation-schedule-input-gate'
import { isValidAutomationSchedule } from '../../../src/shared/automation-schedule-parsing'
import { MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS } from '../../../src/shared/automation-precheck'

export type AutomationDraft = {
  targetEdited?: boolean
  setupDecisionEdited?: boolean
  name: string
  prompt: string
  agentId: TuiAgent | null
  surface?: MobileAutomation['surface']
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
    surface: current?.surface,
    setupId: current?.runContext
      ? automationSetupKey({ ...current.runContext, id: current.runContext.projectHostSetupId })
      : '',
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

export function validateAutomationDraft(
  draft: AutomationDraft,
  step: number,
  saved?: MobileAutomation
): string | null {
  if (!draft.name.trim() || !draft.prompt.trim() || !draft.agentId) {
    return translate(
      'automations.mobile.addANameInstructionsAndAnAgent',
      'Add a name, instructions and an agent.'
    )
  }
  if (draft.workspaceMode === 'existing' && !draft.workspaceId) {
    return translate(
      'automations.mobile.chooseAnExistingWorkspace',
      'Choose an existing workspace.'
    )
  }
  if (
    !saved ||
    draft.agentId !== saved.agentId ||
    draft.extraAgentArgs !== (saved.extraAgentArgs ?? '') ||
    draft.reuseSession !== (saved.reuseSession ?? false)
  ) {
    try {
      assertAutomationExtraAgentArgs({ ...draft, agentId: draft.agentId })
    } catch (failure) {
      return failure instanceof Error
        ? failure.message
        : translate(
            'automations.mobile.checkTheExtraAgentArguments',
            'Check the extra agent arguments.'
          )
    }
  }
  if (step < 2) {
    return null
  }
  if (
    !acceptsAutomationDraftSchedule({
      customSchedule: draft.rrule,
      savedRrule: saved?.rrule ?? null,
      validate: isValidAutomationSchedule
    })
  ) {
    return translate(
      'automations.mobile.enterAValidCronOrRRULESchedule',
      'Enter a valid cron or RRULE schedule.'
    )
  }
  if (draft.timezone !== saved?.timezone) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: draft.timezone }).format()
    } catch {
      return translate(
        'automations.mobile.enterAValidTimeZoneSuchAsAmericaLosAngeles',
        'Enter a valid time zone, such as America/Los_Angeles.'
      )
    }
  }
  if (
    draft.grace !== String(saved?.missedRunGraceMinutes) &&
    (!draft.grace.trim() || !Number.isInteger(Number(draft.grace)) || Number(draft.grace) < 0)
  ) {
    return translate(
      'automations.mobile.missedRunGraceMustBeZeroOrAPositiveNumberOfMinutes',
      'Missed-run grace must be zero or a positive number of minutes.'
    )
  }
  if (
    (draft.precheckCommand !== (saved?.precheck?.command ?? '') ||
      draft.precheckTimeout !== String(saved?.precheck?.timeoutSeconds ?? 60)) &&
    draft.precheckCommand.trim() &&
    (!Number.isInteger(Number(draft.precheckTimeout)) ||
      Number(draft.precheckTimeout) < 1 ||
      Number(draft.precheckTimeout) > MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS)
  ) {
    return translate(
      'automations.mobile.precheckTimeoutRange',
      'Precheck timeout must be between 1 and {{maximum}} seconds.',
      { maximum: MAX_AUTOMATION_PRECHECK_TIMEOUT_SECONDS }
    )
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
  const fields: Record<string, unknown> = editableFields(draft)
  const before: Record<string, unknown> = editableFields(original)
  const patch: UpdateFields = {}
  for (const key of new Set([...Object.keys(before), ...Object.keys(fields)])) {
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
  const setup = targets.setups.find((entry) => automationSetupKey(entry) === draft.setupId)
  if (!setup || !draft.agentId) {
    throw new AutomationDraftValidationError('project')
  }
  assertAutomationExtraAgentArgs({ ...draft, agentId: draft.agentId })
  const workspace = targets.workspaces.find(
    (entry) => entry.worktreeId === draft.workspaceId && workspaceMatchesSetup(entry, setup)
  )
  if (draft.workspaceMode === 'existing' && !workspace) {
    throw new AutomationDraftValidationError('workspace')
  }
  if (setup.kind === 'folder' && draft.workspaceMode !== 'existing') {
    throw new AutomationDraftValidationError('workspace')
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
    !draft.targetEdited &&
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
