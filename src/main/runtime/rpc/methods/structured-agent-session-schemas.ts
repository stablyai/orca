// Wire validation for `agentSession.*`.
//
// Strict objects throughout: zod drops unknown keys, and a silently dropped key
// is how a newer client's field becomes a different effect on an older host.

import { z } from 'zod'
import { isAgentSessionId } from '../../../../shared/agent-session-record'
import {
  AGENT_SESSION_HISTORY_DIRECTIONS,
  AGENT_SESSION_HISTORY_MAX_LIMIT
} from '../../../../shared/agent-session-wire'
import { normalizeExecutionHostId } from '../../../../shared/execution-host'

const MAX_ID_LENGTH = 512
const MAX_PROMPT_BYTES = 256 * 1024
const MAX_BLOCKS = 64
const MAX_OPTION_LABEL = 512

export const SessionId = z
  .string()
  .max(MAX_ID_LENGTH)
  .refine(isAgentSessionId, 'Invalid agent session id')

const Identifier = (message: string) =>
  z
    .string()
    .min(1, message)
    .max(MAX_ID_LENGTH, message)
    .refine((value) => value === value.trim(), message)

export const JournalCursor = z
  .object({
    epoch: Identifier('Invalid journal epoch'),
    sequence: z.number().int().nonnegative()
  })
  .strict()

export const MutationEnvelope = z
  .object({
    sessionId: SessionId,
    clientOperationId: Identifier('Invalid client operation id'),
    /** Null is the "must not exist yet" case; every other call fences. */
    expectedRuntimeFence: z.number().int().positive().nullable(),
    payloadFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'Payload fingerprint must be a sha256 hex digest')
  })
  .strict()

const ProviderHandle = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('codex'), threadId: Identifier('Invalid thread id') }).strict(),
  z
    .object({
      kind: z.literal('claude'),
      sessionId: Identifier('Invalid provider session id'),
      leafUuid: Identifier('Invalid leaf uuid').nullable()
    })
    .strict()
])

const ExecutionHostId = z
  .string()
  .max(MAX_ID_LENGTH)
  .transform((value) => normalizeExecutionHostId(value))
  .refine((value): value is NonNullable<typeof value> => value !== null, {
    message: 'Invalid execution host id'
  })

const ExecutionLocation = z
  .object({
    executionHostId: ExecutionHostId,
    wslDistro: Identifier('Invalid WSL distro').nullable(),
    workspaceId: Identifier('Invalid workspace id'),
    workspaceKind: z.enum(['git-worktree', 'folder'])
  })
  .strict()

const AccountHome = z
  .object({
    variable: z.enum(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']),
    path: z.string().min(1).max(4096)
  })
  .strict()

export const AttachParams = z
  .object({
    envelope: MutationEnvelope,
    location: ExecutionLocation,
    provider: z.enum(['codex', 'claude']),
    agent: Identifier('Invalid agent'),
    accountHome: AccountHome,
    runtimeKind: z.enum(['native', 'tui']),
    providerHandle: ProviderHandle
  })
  .strict()

export const CreateIntentParams = z
  .object({
    envelope: MutationEnvelope,
    worktree: Identifier('Invalid worktree selector'),
    agent: z.literal('codex')
  })
  .strict()

export const CreateParams = z.union([AttachParams, CreateIntentParams])

export const CreateSupportParams = z
  .object({
    worktree: Identifier('Invalid worktree selector'),
    agent: z.literal('codex')
  })
  .strict()

/** Clients may only author user turns. Accepting an assistant or tool role here
 *  would let one client write words into the agent's mouth in another's
 *  timeline, and the provider — not the client — owns those. */
const SendBlock = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }).strict(),
  z
    .object({
      type: z.literal('image-ref'),
      path: z.string().min(1).max(4096).optional(),
      url: z.string().min(1).max(4096).optional(),
      alt: z.string().max(MAX_OPTION_LABEL).optional()
    })
    .strict()
    .refine(
      (value) => Boolean(value.path) !== Boolean(value.url),
      'Provide exactly one of path/url'
    )
])

export const SendParams = z
  .object({
    envelope: MutationEnvelope,
    retryUnknown: z.literal(true).optional(),
    body: z
      .object({
        kind: z.literal('message'),
        role: z.literal('user'),
        blocks: z.array(SendBlock).min(1).max(MAX_BLOCKS)
      })
      .strict()
      .refine(
        (value) => Buffer.byteLength(JSON.stringify(value.blocks), 'utf8') <= MAX_PROMPT_BYTES,
        'Message is too large'
      )
  })
  .strict()

export const CancelParams = z
  .object({ envelope: MutationEnvelope, turnId: Identifier('Invalid turn id') })
  .strict()

export const RespondParams = z
  .object({
    envelope: MutationEnvelope,
    itemId: Identifier('Invalid item id'),
    /** Compare-and-set: the revision the client had on screen. */
    expectedRevision: z.number().int().positive(),
    optionId: Identifier('Invalid option id')
  })
  .strict()

export const SetOptionParams = z
  .object({
    envelope: MutationEnvelope,
    key: Identifier('Invalid option key'),
    value: z.string().max(MAX_OPTION_LABEL)
  })
  .strict()

export const OptionsParams = z.object({ sessionId: SessionId }).strict()

/** One surface's claim on one session. The id names the surface, not the client: two chat views
 *  looking at the same session are two holders, and either leaving must not release
 *  the other's. */
export const HoldParams = z
  .object({ sessionId: SessionId, holderId: Identifier('Invalid holder id') })
  .strict()

export const HistoryParams = z
  .object({
    sessionId: SessionId,
    direction: z.enum(AGENT_SESSION_HISTORY_DIRECTIONS),
    cursor: JournalCursor.optional(),
    limit: z.number().int().positive().max(AGENT_SESSION_HISTORY_MAX_LIMIT).optional()
  })
  .strict()

export const SubscribeParams = z
  .object({ sessionId: SessionId, cursor: JournalCursor.optional() })
  .strict()

export const UnsubscribeParams = z
  .object({
    sessionId: SessionId,
    subscriptionId: Identifier('Invalid subscription id').optional()
  })
  .strict()

/** Read-only owner classification retained for restart safety; mutation handoff is separate. */
export const HandoffStatusParams = z.object({ sessionId: SessionId }).strict()
