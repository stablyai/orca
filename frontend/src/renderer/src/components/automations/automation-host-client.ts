import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  Automation,
  AutomationAction,
  AutomationCreateInput,
  AutomationRun,
  AutomationUpdateInput
} from '../../../../shared/automations-types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'

// RuntimeAutomationAction is actions[]'s WIRE shape (backend-go's
// automationv1.AutomationAction, camelCase JSON) — distinct from
// AutomationAction (the frontend/UI shape, `config` as a nested object).
// `configJson` must be a pre-serialized JSON string:
// api-gateway's wscompat automation.create/automation.update decode
// actions[].configJson as a plain string field (backend-go/services/
// api-gateway/internal/adapter/wscompat/channels_automation_task.go's
// automationActionArg), not a nested object it re-marshals — confirmed by
// reading that handler directly (FE-TASK-AUTO-002's required Bước 1),
// rather than assuming callRuntimeRpc's JSON transport does this for us.
type RuntimeAutomationAction = {
  id: string
  type: AutomationAction['type']
  configJson: string
  continueOnFailure?: boolean
}

function toRuntimeAutomationAction(action: AutomationAction): RuntimeAutomationAction {
  return {
    id: action.id,
    type: action.type,
    configJson: JSON.stringify(action.config),
    continueOnFailure: action.continueOnFailure
  }
}

// toDefaultRunAgentAction — FE-AUTO-SOL-002 §3's "1-action chain" bridge:
// the legacy single-prompt form (AutomationsPage.tsx) has no multi-action
// UI yet (FE-AUTO-SOL-003/004 add that), so a runtime-target create/update
// with no explicit `actions` synthesizes one `run_agent` action from
// prompt/agentId — backend-go's CreateAutomation requires either `actions`
// or `step_config_json`+`step_type` (see create_automation.go), and this
// path never populates the legacy step fields, so `actions` must carry the
// real config.
function toDefaultRunAgentAction(prompt: string, agentId: TuiAgent): RuntimeAutomationAction {
  return {
    id: 'primary',
    type: 'run_agent',
    configJson: JSON.stringify({ prompt, agentId })
  }
}

type RuntimeAutomationCreateInput = Omit<
  AutomationCreateInput,
  'projectId' | 'workspaceId' | 'timezone' | 'actions'
> & {
  repo?: string
  workspace?: string
  timezone?: string
  actions?: RuntimeAutomationAction[]
}

type RuntimeAutomationUpdateInput = Omit<
  AutomationUpdateInput,
  'projectId' | 'workspaceId' | 'actions'
> & {
  repo?: string
  workspace?: string
  actions?: RuntimeAutomationAction[]
}

export type AutomationHostTarget =
  | { kind: 'local' }
  | { kind: 'environment'; environmentId: string }

export function getAutomationTargetFromHostId(
  hostId: string | null | undefined
): AutomationHostTarget {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime'
    ? { kind: 'environment', environmentId: parsed.environmentId }
    : { kind: 'local' }
}

export function getAutomationListTarget(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): AutomationHostTarget {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
}

export function getAutomationOwnerTarget(
  automation: Pick<Automation, 'runContext'>,
  sourceTarget?: AutomationHostTarget | null
): AutomationHostTarget {
  if (sourceTarget?.kind === 'environment') {
    return sourceTarget
  }
  return getAutomationTargetFromHostId(automation.runContext?.hostId)
}

export function getAutomationCreateTarget(input: AutomationCreateInput): AutomationHostTarget {
  return getAutomationTargetFromHostId(input.runContext?.hostId)
}

function toRuntimeAutomationCreateInput(
  input: AutomationCreateInput
): RuntimeAutomationCreateInput {
  const { projectId, workspaceId, actions, ...rest } = input
  return {
    ...rest,
    repo: projectId,
    workspace: input.workspaceMode === 'existing' ? (workspaceId ?? undefined) : undefined,
    actions: actions
      ? actions.map(toRuntimeAutomationAction)
      : [toDefaultRunAgentAction(input.prompt, input.agentId)]
  }
}

function toRuntimeAutomationUpdateInput(
  input: AutomationUpdateInput
): RuntimeAutomationUpdateInput {
  const { projectId, workspaceId, actions, prompt, agentId, ...rest } = input
  return {
    ...rest,
    ...(prompt !== undefined ? { prompt } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(projectId !== undefined ? { repo: projectId } : {}),
    ...(workspaceId !== undefined ? { workspace: workspaceId ?? undefined } : {}),
    // Why: `actions` is tri-state (see RuntimeAutomationUpdateInput's own
    // Omit — mirrors UpdateAutomationRequest.actions_set's nil-vs-empty
    // semantics), so this key must be OMITTED, not set to undefined, when
    // no chain edit is intended — a partial update like {enabled} alone
    // (AutomationsPage.tsx's toggleAutomation) must leave the automation's
    // existing chain untouched, not clear it.
    ...(actions !== undefined
      ? { actions: actions.map(toRuntimeAutomationAction) }
      : prompt !== undefined && agentId !== undefined
        ? // Full-form edit (AutomationsPage.tsx always sends prompt+agentId
          // together on save) with no explicit multi-action `actions` yet —
          // same 1-action synthesis as create, so editing the prompt of an
          // existing runtime automation actually changes what dispatches.
          { actions: [toDefaultRunAgentAction(prompt, agentId)] }
        : {})
  }
}

export async function listAutomationsForTarget(
  target: AutomationHostTarget
): Promise<Automation[]> {
  if (target.kind === 'local') {
    return await window.api.automations.list()
  }
  const result = await callRuntimeRpc<{ automations: Automation[] }>(
    target,
    'automation.list',
    undefined,
    { timeoutMs: 15_000 }
  )
  // Why: proto3 `repeated` fields marshal with `omitempty` — a tenant with
  // zero automations gets a response with no `automations` key at all, not
  // an empty array (live-reproduced as "Cannot read properties of undefined
  // (reading 'some')" in AutomationsPage's refresh()).
  return result.automations ?? []
}

export async function listAutomationRunsForTarget(
  target: AutomationHostTarget,
  automationId?: string
): Promise<AutomationRun[]> {
  if (target.kind === 'local') {
    return await window.api.automations.listRuns(automationId ? { automationId } : undefined)
  }
  const result = await callRuntimeRpc<{ runs: AutomationRun[] }>(
    target,
    'automation.runs',
    automationId ? { automationId } : {},
    { timeoutMs: 15_000 }
  )
  // Why: same proto3 omitempty gap as listAutomationsForTarget above — a
  // tenant/automation with zero runs gets no `runs` key at all.
  return result.runs ?? []
}

export async function createAutomationForTarget(input: AutomationCreateInput): Promise<Automation> {
  const target = getAutomationCreateTarget(input)
  if (target.kind === 'local') {
    return await window.api.automations.create(input)
  }
  const result = await callRuntimeRpc<{ automation: Automation }>(
    target,
    'automation.create',
    toRuntimeAutomationCreateInput(input),
    { timeoutMs: 15_000 }
  )
  return result.automation
}

export async function updateAutomationForTarget(
  automation: Automation,
  updates: AutomationUpdateInput,
  sourceTarget?: AutomationHostTarget | null
): Promise<Automation> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
  if (target.kind === 'local') {
    return await window.api.automations.update({ id: automation.id, updates })
  }
  // Why: FLAT, not { id, updates: {...} } — api-gateway's wscompat
  // automation.update decodes `id` and every update field as SIBLINGS of
  // one top-level object (channels_automation_task.go's updateArgs
  // struct), unlike window.api.automations.update's Node "server mode"
  // handler above, which does expect a nested `updates` envelope. Sending
  // the nested shape here silently no-ops every field but `id` — a real,
  // previously undetected bug found while auditing this call against the
  // Go decode struct directly (FE-TASK-AUTO-002's required Bước 1),
  // because automation-host-client.test.ts's callRuntimeRpc mock never
  // validated the payload against the real wire contract.
  const result = await callRuntimeRpc<{ automation: Automation }>(
    target,
    'automation.update',
    { id: automation.id, ...toRuntimeAutomationUpdateInput(updates) },
    { timeoutMs: 15_000 }
  )
  return result.automation
}

// Why: fallback path when the automation being edited could not be re-fetched
// (e.g. list refresh failed) — the caller only has an id, not a full
// Automation to derive the owner target from, so the caller-resolved target
// is used as-is instead of routing through getAutomationOwnerTarget.
export async function updateAutomationByIdForTarget(
  target: AutomationHostTarget | null | undefined,
  id: string,
  updates: AutomationUpdateInput
): Promise<Automation> {
  const resolvedTarget = target ?? { kind: 'local' }
  if (resolvedTarget.kind === 'local') {
    return await window.api.automations.update({ id, updates })
  }
  // Why: same flat shape as updateAutomationForTarget above — see that
  // function's comment.
  const result = await callRuntimeRpc<{ automation: Automation }>(
    resolvedTarget,
    'automation.update',
    { id, ...toRuntimeAutomationUpdateInput(updates) },
    { timeoutMs: 15_000 }
  )
  return result.automation
}

export async function deleteAutomationForTarget(
  automation: Automation,
  sourceTarget?: AutomationHostTarget | null
): Promise<void> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
  if (target.kind === 'local') {
    await window.api.automations.delete({ id: automation.id })
    return
  }
  await callRuntimeRpc(target, 'automation.delete', { id: automation.id }, { timeoutMs: 15_000 })
}

export async function runAutomationNowForTarget(
  automation: Automation,
  sourceTarget?: AutomationHostTarget | null
): Promise<AutomationRun> {
  const target = getAutomationOwnerTarget(automation, sourceTarget)
  if (target.kind === 'local') {
    return await window.api.automations.runNow({ id: automation.id })
  }
  const result = await callRuntimeRpc<{ run: AutomationRun }>(
    target,
    'automation.runNow',
    { id: automation.id },
    { timeoutMs: 15_000 }
  )
  return result.run
}
