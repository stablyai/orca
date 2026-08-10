import { z } from 'zod'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import {
  NATIVE_CHAT_ROLES,
  NATIVE_CHAT_SOURCES,
  NATIVE_CHAT_TURN_LIFECYCLE_STATES
} from '../../shared/native-chat-types'
import {
  SSH_NATIVE_CHAT_READ_TRANSCRIPT_TIMEOUT_MS,
  type SshNativeChatRelayReadParams,
  type SshNativeChatRelayReadResult
} from '../../shared/ssh-native-chat-relay'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { agentHookServer } from '../agent-hooks/server'
import { getSshNativeChatTranscriptReader } from './ssh-transcript-dispatch'

export type SshNativeChatReadArgs = {
  agent: AgentType
  sessionId: string
  transcriptPath?: string
  limit: number
  beforeOffset?: number
  knownFileSize?: number
}

export type NativeChatSshOwner = {
  connectionId: string
  /** The hook's own transcript path for this session, when it reported one.
   *  Only this path is ever forwarded to a relay: a client-supplied path would
   *  let any paired client name a file on the remote host. */
  transcriptPath?: string
}

/**
 * The SSH connection that owns an agent session's transcript, or null when the
 * session's transcript is readable by this process.
 *
 * Why: the native chat wire contract carries no host, so the only authority for
 * "which machine is this agent writing on" is the hook row the agent already
 * published: `ingestRemote` stamps it with the connection it arrived on
 * (docs/design/agent-status-over-ssh.md §5). A path match wins over an id match,
 * because recent Claude Code names the transcript file with a UUID that differs
 * from the hook session id, so the id is the weaker signal of the two.
 *
 * WSL rows carry a `wsl:<distro>` connection id and are NOT a relay target: the
 * guest transcript is reachable from the Windows host through the UNC twin
 * (`host-readable-transcript-path.ts`), so those stay on the local reader.
 */
export function resolveNativeChatSshOwner(args: {
  sessionId: string
  transcriptPath?: string
}): NativeChatSshOwner | null {
  const sessionId = args.sessionId.trim()
  const transcriptPath = args.transcriptPath?.trim()
  if (!sessionId && !transcriptPath) {
    return null
  }
  let idMatch: NativeChatSshOwner | null = null
  for (const status of agentHookServer.getStatusSnapshot()) {
    const connectionId = status.connectionId
    if (!connectionId || isWslHookRelayConnectionId(connectionId)) {
      continue
    }
    const providerSession = status.providerSession
    if (!providerSession) {
      continue
    }
    const hookPath = providerSession.transcriptPath
    if (transcriptPath && hookPath === transcriptPath) {
      return { connectionId, transcriptPath: hookPath }
    }
    if (!idMatch && sessionId && providerSession.id === sessionId) {
      idMatch = { connectionId, ...(hookPath ? { transcriptPath: hookPath } : {}) }
    }
  }
  return idMatch
}

/** Reads the transcript on the SSH host. Null means the relay gave no answer:
 *  the target is not connected yet, or the deployed relay predates the method. */
export async function readSshNativeChatTranscript(
  connectionId: string,
  args: SshNativeChatReadArgs,
  signal?: AbortSignal
): Promise<SshNativeChatRelayReadResult | null> {
  const params: SshNativeChatRelayReadParams = {
    agent: args.agent,
    sessionId: args.sessionId,
    limit: args.limit,
    ...(args.transcriptPath === undefined ? {} : { transcriptPath: args.transcriptPath }),
    ...(args.beforeOffset === undefined ? {} : { beforeOffset: args.beforeOffset }),
    ...(args.knownFileSize === undefined ? {} : { knownFileSize: args.knownFileSize })
  }
  const reader = getSshNativeChatTranscriptReader(connectionId)
  if (!reader) {
    return null
  }
  const raw = await reader(params, { signal, timeoutMs: SSH_NATIVE_CHAT_READ_TRANSCRIPT_TIMEOUT_MS })
  if (raw === null) {
    return null
  }
  const parsed = relayReadResultSchema.safeParse(raw)
  // A payload this process cannot read is a miss, not content: rendering junk
  // would be worse than retrying.
  return parsed.success ? parsed.data : { error: 'Transcript unavailable', notFound: true }
}

// Why: the relay is deployed by this desktop build, so the payload is our own
// shape rather than untrusted input. Validate the envelope (the fields this
// process branches on) and keep the message bodies structural. The runtime RPC
// layer still windows and sanitizes every message before any client sees it.
const messageSchema = z
  .object({
    id: z.string(),
    role: z.enum(NATIVE_CHAT_ROLES),
    blocks: z.array(z.unknown()),
    timestamp: z.number().nullable(),
    source: z.enum(NATIVE_CHAT_SOURCES),
    turnId: z.string().optional()
  })
  .transform((message) => message as NativeChatMessage)

const lifecycleSchema = z.object({
  state: z.enum(NATIVE_CHAT_TURN_LIFECYCLE_STATES),
  turnId: z.string(),
  timestamp: z.number().nullable()
})

const relayReadResultSchema = z.union([
  z.object({ unchanged: z.literal(true), fileSize: z.number().nonnegative() }),
  z.object({
    appended: z.array(messageSchema),
    fileSize: z.number().nonnegative(),
    lifecycle: lifecycleSchema.optional(),
    filePath: z.string().optional()
  }),
  z.object({
    messages: z.array(messageSchema),
    hasMore: z.boolean(),
    beforeOffset: z.number().nonnegative(),
    lifecycle: lifecycleSchema.optional(),
    fileSize: z.number().nonnegative(),
    filePath: z.string().optional()
  }),
  z.object({ error: z.string(), notFound: z.literal(true).optional() })
])
