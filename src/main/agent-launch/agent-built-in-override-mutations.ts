// Built-in agent override mutation: persists per-agent command/args/env overrides
// for a shipped built-in. Built-in prefixes keep multi-token wrapper
// compatibility, so only control characters and hard bounds are save-rejected.

import type { GlobalSettings } from '../../shared/types'
import type { AgentCatalogMutationRequest } from '../../shared/agent-catalog-snapshot'
import { validateCustomAgentEnv } from '../../shared/custom-tui-agents'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import { fieldError, type AgentCatalogMutationApplication } from './agent-catalog-draft-validation'

type UpdateBuiltInMutation = Extract<
  AgentCatalogMutationRequest['mutation'],
  { kind: 'update-built-in' }
>

export function applyUpdateBuiltIn(
  mutation: UpdateBuiltInMutation,
  settings: GlobalSettings,
  newRevision: number
): AgentCatalogMutationApplication {
  if (!isBuiltInTuiAgent(mutation.agent)) {
    return { ok: false, code: 'invalid_agent_field', reason: 'identity_mismatch' }
  }
  // IPC validates only the request envelope; malformed changes payloads must
  // fail typed instead of throwing on the field accesses below.
  const changes: unknown = mutation.changes
  if (typeof changes !== 'object' || changes === null || Array.isArray(changes)) {
    return { ok: false, code: 'invalid_agent_field', reason: 'bounds' }
  }
  if (typeof mutation.changes.args !== 'string') {
    return { ok: false, code: 'invalid_agent_field', field: 'args', reason: 'bounds' }
  }
  // Built-in prefixes keep multi-token wrapper compatibility, so only
  // control characters and bounds are save-rejected here; operator tokens
  // fail at launch with a repairable error instead of being reinterpreted.
  const override = mutation.changes.commandOverride
  if (override !== null && override !== undefined) {
    if (typeof override !== 'string') {
      return { ok: false, code: 'invalid_agent_field', field: 'commandOverride', reason: 'bounds' }
    }
    if (override.length > 4096) {
      return { ok: false, code: 'invalid_agent_field', field: 'commandOverride', reason: 'bounds' }
    }
    // eslint-disable-next-line no-control-regex -- rejecting control chars is the point
    if (/[\0\r\n\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(override)) {
      return {
        ok: false,
        code: 'invalid_agent_field',
        field: 'commandOverride',
        reason: 'control_char'
      }
    }
  }
  if (mutation.changes.args.length > 8192) {
    return { ok: false, code: 'invalid_agent_field', field: 'args', reason: 'bounds' }
  }
  // Built-in env applies the full custom-agent env rules: reserved ORCA_*
  // names (host attribution/control namespace) and case collisions are as
  // impersonation-prone for a built-in as for a custom derivative.
  const envIssues = validateCustomAgentEnv(mutation.changes.env)
  if (envIssues.length > 0) {
    return fieldError(envIssues[0])
  }
  const agent = mutation.agent
  const nextCmdOverrides = { ...settings.agentCmdOverrides }
  if (override === null || override === undefined || override.trim().length === 0) {
    delete nextCmdOverrides[agent]
  } else {
    nextCmdOverrides[agent] = override
  }
  const nextArgs = { ...settings.agentDefaultArgs }
  if (mutation.changes.args.trim().length === 0) {
    delete nextArgs[agent]
  } else {
    nextArgs[agent] = mutation.changes.args
  }
  // Persist a null-prototype copy of the validated entries (own keys only),
  // never the raw incoming record.
  const validatedEnv: Record<string, string> = Object.create(null) as Record<string, string>
  for (const [key, value] of Object.entries(mutation.changes.env ?? {})) {
    validatedEnv[key] = value
  }
  const nextEnv = { ...settings.agentDefaultEnv }
  if (Object.keys(validatedEnv).length === 0) {
    delete nextEnv[agent]
  } else {
    nextEnv[agent] = validatedEnv
  }
  return {
    ok: true,
    patch: {
      agentCmdOverrides: nextCmdOverrides,
      agentDefaultArgs: nextArgs,
      agentDefaultEnv: nextEnv,
      agentCatalogRevision: newRevision
    },
    newRevision,
    prunedTombstoneIds: []
  }
}
