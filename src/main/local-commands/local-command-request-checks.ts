import { z } from 'zod'
import {
  LOCAL_COMMAND_MAX_TIMEOUT_SEC,
  LocalCommandCwd,
  LocalCommandText,
  sanitizeLocalCommandReason
} from '../../shared/local-commands/local-command-contract'
import type { LocalCommandWorkspaceSetting } from './local-command-settings-store'
import type { LocalCommandPrompt } from '../../shared/local-commands/local-command-desktop-types'
import { assessLocalCommandRisk } from '../../shared/local-commands/local-command-risk'

export const LOCAL_COMMAND_REQUEST_ID = /^lc_[A-Za-z0-9_-]{16,64}$/

/** What orcad sent, checked again here: the VM is never trusted to have validated it. */
export const LocalCommandRequestedEventSchema = z.object({
  type: z.literal('requested'),
  requestId: z.string().regex(LOCAL_COMMAND_REQUEST_ID),
  command: LocalCommandText,
  cwd: LocalCommandCwd.nullable(),
  timeoutSec: z.number().int().min(1).max(LOCAL_COMMAND_MAX_TIMEOUT_SEC),
  reason: z.string().max(800).nullable(),
  agent: z.string().max(200).nullable(),
  expiresInMs: z.number().min(0)
})
export type LocalCommandRequestedEventInput = z.infer<typeof LocalCommandRequestedEventSchema>

export const LocalCommandSettledEventSchema = z.object({
  type: z.literal('settled'),
  requestId: z.string().max(80),
  status: z.string().max(32)
})

/** One field of an untyped wire event, without trusting its shape. */
export function eventField(event: unknown, name: string): unknown {
  return event !== null && typeof event === 'object' && name in event
    ? Object.getOwnPropertyDescriptor(event, name)?.value
    : undefined
}

export function requestIdOf(raw: unknown): string | null {
  const value = eventField(raw, 'requestId')
  return typeof value === 'string' && LOCAL_COMMAND_REQUEST_ID.test(value) ? value : null
}

/** Agent-written display text: one line, hidden characters removed, bounded. */
export function displayText(value: string | null, max: number): string | null {
  return value ? sanitizeLocalCommandReason(value).slice(0, max) || null : null
}

export type LocalCommandWorkspacePolicy = {
  isOwner: boolean
  shared: boolean
  title: string | null
}

/** Why this computer won't take a request from the workspace; null when it may ask the person. */
export function localCommandRefusal(
  supported: boolean,
  setting: LocalCommandWorkspaceSetting | null,
  policy: LocalCommandWorkspacePolicy | null
): string | null {
  if (!supported || !setting?.enabled) {
    return 'Local commands are off for this workspace.'
  }
  if (!policy) {
    return "Couldn't confirm who owns this workspace."
  }
  if (!policy.isOwner) {
    return 'Only the workspace owner can run local commands.'
  }
  if (policy.shared && !setting.sharedAllowed) {
    return 'The workspace is shared with teammates.'
  }
  return null
}

/** The prompt the person sees, from a validated event and what this computer resolved itself. */
export function buildLocalCommandPrompt(
  event: LocalCommandRequestedEventInput,
  base: { requestId: string; sandboxId: string; agent: string | null },
  local: { cwd: string; workspaceLabel: string; shared: boolean; expiresAt: number }
): LocalCommandPrompt {
  const risk = assessLocalCommandRisk(event.command, local.cwd)
  return {
    id: base.requestId,
    sandboxId: base.sandboxId,
    workspaceLabel: local.workspaceLabel,
    shared: local.shared,
    command: event.command,
    cwd: local.cwd,
    timeoutSec: event.timeoutSec,
    reason: displayText(event.reason, 200),
    agent: base.agent,
    hasNonAscii: risk.nonAscii,
    pipesToShell: risk.pipesToShell,
    alwaysAllowBlocked: risk.alwaysAllowBlocked,
    expiresAt: local.expiresAt
  }
}
