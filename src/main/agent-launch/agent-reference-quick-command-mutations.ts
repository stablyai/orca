// Quick-command owner mutations of the agent-reference engine: save (with the
// field-level agent rule and persisted-as-sent bounds), delete, and reorder.
// Sibling of agent-reference-mutations.ts, which dispatches into these.

import type { GlobalSettings, TerminalQuickCommand } from '../../shared/types'
import type { AgentReferenceMutation } from '../../shared/agent-reference-snapshot'
import { CUSTOM_AGENT_ID } from '../../shared/commit-message-agent-spec'
import { isBuiltInTuiAgent } from '../../shared/tui-agent-config'
import type { AgentCatalog } from '../../shared/custom-tui-agents'
import { supportsTerminalAgentQuickCommand } from '../../shared/terminal-quick-commands'
import { decideAgentField } from './agent-reference-field-decision'
import type { AgentReferenceMutationApplication } from './agent-reference-mutations'

// Store.updateSettings re-runs normalizeTerminalQuickCommands on every write,
// which silently drops rows past the cap and truncates long ids/labels/bodies.
// Saves must fail these bounds up front so ok:true always means persisted
// as sent. Keep in sync with the caps in shared/terminal-quick-commands.ts.
const MAX_QUICK_COMMANDS = 40
const MAX_QUICK_COMMAND_ID_OR_LABEL_LENGTH = 80
const MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH = 4000
const MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH = 6000

type QuickCommandSaveMutation = Extract<AgentReferenceMutation, { kind: 'quick-command-save' }>
type QuickCommandsReorderMutation = Extract<
  AgentReferenceMutation,
  { kind: 'quick-commands-reorder' }
>

export function applyQuickCommandSave(
  mutation: QuickCommandSaveMutation,
  settings: GlobalSettings,
  catalog: AgentCatalog,
  newReferenceRevision: number
): AgentReferenceMutationApplication {
  const incoming = mutation.command
  if (
    !incoming ||
    typeof incoming !== 'object' ||
    typeof incoming.id !== 'string' ||
    incoming.id.length === 0 ||
    typeof incoming.label !== 'string'
  ) {
    return {
      ok: false,
      code: 'invalid_reference_field',
      owner: 'quick-command',
      reason: 'bounds'
    }
  }
  const bodyTooLong =
    incoming.action === 'agent-prompt'
      ? typeof incoming.prompt === 'string' &&
        incoming.prompt.length > MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH
      : typeof incoming.command === 'string' &&
        incoming.command.length > MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
  if (
    incoming.id.length > MAX_QUICK_COMMAND_ID_OR_LABEL_LENGTH ||
    incoming.label.length > MAX_QUICK_COMMAND_ID_OR_LABEL_LENGTH ||
    bodyTooLong
  ) {
    return {
      ok: false,
      code: 'invalid_reference_field',
      owner: 'quick-command',
      field: bodyTooLong ? (incoming.action === 'agent-prompt' ? 'prompt' : 'command') : 'label',
      reason: 'bounds'
    }
  }
  const commands = settings.terminalQuickCommands ?? []
  const existing = commands.find((command) => command.id === incoming.id)
  if (!existing && commands.length >= MAX_QUICK_COMMANDS) {
    return {
      ok: false,
      code: 'invalid_reference_field',
      owner: 'quick-command',
      field: 'count',
      reason: 'bounds'
    }
  }
  let toStore: TerminalQuickCommand = incoming
  if (incoming.action === 'agent-prompt') {
    const storedAgent = existing && existing.action === 'agent-prompt' ? existing.agent : undefined
    const decision = decideAgentField({
      incoming: incoming.agent,
      stored: storedAgent,
      catalog,
      allowCustomSentinel: false
    })
    if (!decision.ok) {
      return {
        ok: false,
        code: 'invalid_agent_reference',
        owner: 'quick-command',
        field: 'agent',
        reason: decision.reason
      }
    }
    // An agent-prompt quick command cannot exist without an agent: an
    // omitted field keeps the stored reference; there is nothing to clear to.
    const agent = decision.value === undefined ? storedAgent : decision.value
    if (agent === null || agent === undefined || agent === CUSTOM_AGENT_ID) {
      return {
        ok: false,
        code: 'invalid_agent_reference',
        owner: 'quick-command',
        field: 'agent',
        reason: 'unknown_agent'
      }
    }
    // Base capability must hold at save time: normalization silently drops
    // stdin-after-start rows later, so an incapable base must fail the save
    // rather than return ok while the command vanishes. A stale custom id
    // whose base cannot be proven stays preserved per the field-level rule.
    const capabilityBase = isBuiltInTuiAgent(agent) ? agent : catalog.liveById.get(agent)?.baseAgent
    if (capabilityBase !== undefined && !supportsTerminalAgentQuickCommand(capabilityBase)) {
      return {
        ok: false,
        code: 'invalid_agent_reference',
        owner: 'quick-command',
        field: 'agent',
        reason: 'unknown_agent'
      }
    }
    toStore = { ...incoming, agent }
  }
  const next = existing
    ? commands.map((command) => (command.id === incoming.id ? toStore : command))
    : [...commands, toStore]
  return {
    ok: true,
    patch: { terminalQuickCommands: next, agentReferenceRevision: newReferenceRevision },
    newReferenceRevision
  }
}

export function applyQuickCommandDelete(
  id: string,
  settings: GlobalSettings,
  newReferenceRevision: number
): AgentReferenceMutationApplication {
  const commands = settings.terminalQuickCommands ?? []
  const next = commands.filter((command) => command.id !== id)
  return {
    ok: true,
    patch: { terminalQuickCommands: next, agentReferenceRevision: newReferenceRevision },
    newReferenceRevision
  }
}

export function applyQuickCommandsReorder(
  mutation: QuickCommandsReorderMutation,
  settings: GlobalSettings,
  newReferenceRevision: number
): AgentReferenceMutationApplication {
  const commands = settings.terminalQuickCommands ?? []
  const byId = new Map(commands.map((command) => [command.id, command]))
  if (
    // IPC validates only the envelope; a malformed field payload must fail
    // typed instead of throwing out of the handler.
    !Array.isArray(mutation.orderedIds) ||
    mutation.orderedIds.length !== commands.length ||
    mutation.orderedIds.some((id) => !byId.has(id)) ||
    new Set(mutation.orderedIds).size !== mutation.orderedIds.length
  ) {
    return {
      ok: false,
      code: 'invalid_reference_field',
      owner: 'quick-command',
      reason: 'conflict'
    }
  }
  const next = mutation.orderedIds.map((id) => byId.get(id) as TerminalQuickCommand)
  return {
    ok: true,
    patch: { terminalQuickCommands: next, agentReferenceRevision: newReferenceRevision },
    newReferenceRevision
  }
}
