// Zod schema for the nested `agentLaunch` request accepted by terminal-create
// RPC methods (U3). A CUSTOM agent id is admitted only on this sanctioned path
// (`selection.agent` via isTuiAgent); the legacy `launchAgent`/`agent` fields
// stay built-in-only. The host constructs LaunchIntent/AgentReferenceAuthority
// from its authenticated context — never from this payload.

import { z } from 'zod'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import type {
  AgentLaunchInput,
  AgentLaunchResumeRequest,
  AgentLaunchSpawnRequest,
  AgentLaunchVaultResumeRequest
} from '../../../../shared/agent-launch-spawn-request'
import {
  hasUnsafeProviderSessionIdChars,
  isResumableTuiAgent,
  type ResumableTuiAgent
} from '../../../../shared/agent-session-resume'
import { AI_VAULT_AGENTS, type AiVaultAgent } from '../../../../shared/ai-vault-types'
import { MAX_AGENT_ARGS_CODE_UNITS } from '../../../../shared/custom-tui-agent-fields'
import { parseExecutionHostId } from '../../../../shared/execution-host'

const AgentLaunchSelection = z.union([
  z.object({
    kind: z.literal('agent'),
    agent: z.custom<TuiAgent>(isTuiAgent, { message: 'Unknown agent' })
  }),
  z.object({ kind: z.literal('default') })
])

const AgentLaunchSourceRecord = z.object({
  owner: z.enum([
    'default',
    'quick-command',
    'commit-message',
    'source-control-recipe',
    'session',
    'workspace'
  ]),
  id: z.string().min(1).max(256).optional()
})

export const AgentLaunchSpawnRequestSchema: z.ZodType<AgentLaunchSpawnRequest> = z.object({
  selection: AgentLaunchSelection,
  prompt: z.string().max(100_000).optional(),
  allowEmptyPromptLaunch: z.boolean().optional(),
  promptDelivery: z.enum(['submit', 'draft']).optional(),
  sourceRecord: AgentLaunchSourceRecord.optional(),
  // Untrusted client text that substitutes for the stored recipe args, so it gets
  // the same length ceiling those args are save-validated against.
  unsavedAgentArgs: z.string().max(MAX_AGENT_ARGS_CODE_UNITS).optional(),
  // Why: without this, an unrecognized key would be silently stripped by Zod's
  // default object parsing, downgrading a caller's declared unattended/
  // background launch to interactive instead of failing closed.
  unattended: z.object({ kind: z.literal('background') }).optional()
})

// The ownership key is the ONLY resume/fork input a client supplies; the host
// loads the private record and resolves everything else. `baseAgent` must be a
// resumable base and `providerSessionId` control-char-free and bounded, matching
// the host's own normalization so an untrusted key cannot forge one.
const AgentSessionOwnershipKeySchema = z.object({
  worktreeId: z.string().min(1).max(512),
  baseAgent: z.custom<ResumableTuiAgent>(isResumableTuiAgent, { message: 'Unknown base agent' }),
  providerSessionId: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => !value.startsWith('-') && !hasUnsafeProviderSessionIdChars(value), {
      message: 'Invalid provider session id'
    })
})

export const AgentLaunchResumeRequestSchema: z.ZodType<AgentLaunchResumeRequest> = z.object({
  resume: z.object({
    operation: z.enum(['resume', 'fork']),
    sessionKey: AgentSessionOwnershipKeySchema
  })
})

// The client echoes the host listing's OWN discovered entry identity; the host
// re-validates it against a fresh scan before use. `executionHostId` must parse
// as a known host kind, and `filePath` is bounded — a runtime/paired RPC omits it
// (the host re-derives it), so it stays optional here.
export const AgentLaunchVaultResumeEntrySchema = z.object({
  executionHostId: z
    .string()
    .refine((value) => parseExecutionHostId(value) !== null, { message: 'Invalid execution host' })
    .transform(
      (value) => value as AgentLaunchVaultResumeRequest['vaultResume']['entry']['executionHostId']
    ),
  agent: z.custom<AiVaultAgent>(
    (value) => typeof value === 'string' && (AI_VAULT_AGENTS as readonly string[]).includes(value),
    { message: 'Unknown AI Vault agent' }
  ),
  sessionId: z.string().min(1).max(512),
  resumeLocator: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  filePath: z.string().min(1).max(4096).optional()
})

export const AgentLaunchVaultResumeRequestSchema: z.ZodType<AgentLaunchVaultResumeRequest> =
  z.object({
    vaultResume: z.object({
      operation: z.enum(['resume', 'copy']),
      entry: AgentLaunchVaultResumeEntrySchema
    })
  })

/** The agentLaunch input a terminal-create RPC accepts: a fresh selection launch,
 *  a provider-session resume/fork by ownership key, or an AI Vault session resume.
 *  Discriminated on `resume` / `vaultResume`. */
export const AgentLaunchInputSchema: z.ZodType<AgentLaunchInput> = z.union([
  AgentLaunchResumeRequestSchema,
  AgentLaunchVaultResumeRequestSchema,
  AgentLaunchSpawnRequestSchema
])
