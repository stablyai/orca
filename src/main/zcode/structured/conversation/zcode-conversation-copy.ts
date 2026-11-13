import { homedir } from 'node:os'
import type {
  AgentSessionRewindFork,
  AgentSessionRewindReason
} from '../../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { AiVaultConversationCopy } from '../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { spawnZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection'
import type { ZcodeAppServerConnection } from '../../app-server/zcode-app-server-connection-types'
import {
  pushZcodeAccountConfig,
  readZcodeBuiltinTable
} from '../credentials/zcode-account-config-push'
import type { StructuredAgentCommandSettings } from '../../../native-chat/agent-launch/structured-agent-command-resolution'
import type { ZcodeChatCredentials } from '../credentials/zcode-chat-credentials'
import { zcodeHeadlessLaunch } from '../launch/zcode-headless-launch'

// Fork a persisted zcode conversation over a short-lived app-server of its own — the source chat
// may have no live child, and forked sessions are first-class resume targets. zcode has no rewind
// RPC (0.16 removed it), so Orca rewinds by resuming the fork that keeps the earlier turns. Forks
// anchor on the provider's own message ids (`session/messages` matches them), never on indexes.

export type ZcodeConversationCopy = AiVaultConversationCopy

export class ZcodeConversationCopyRefusedError extends Error {
  constructor(
    readonly reason: AgentSessionRewindReason,
    message: string
  ) {
    super(message)
  }
}

type HeadlessRun = {
  /** The session id after resume; a backend may hand back its own spelling of it. */
  resumedSessionId: string
  /** One RPC against the ephemeral backend. */
  request: <T>(method: string, params: Record<string, unknown>) => Promise<T>
}

/**
 * Boot a disposable backend, answer its asks, push the account snapshot, and resume the source
 * session in-process — persisted sessions fork only after this runtime has loaded them.
 */
async function withZcodeHeadlessConnection<T>(input: {
  environment: NodeJS.ProcessEnv
  commandSettings?: StructuredAgentCommandSettings
  credentials: ZcodeChatCredentials | null
  providerSessionId: string
  signal?: AbortSignal
  run: (headless: HeadlessRun) => Promise<T>
}): Promise<T> {
  const launch = await zcodeHeadlessLaunch(input.environment, {
    commandSettings: input.commandSettings
  })
  const connection = await spawnZcodeAppServerConnection(
    {
      command: launch.command,
      args: launch.args,
      cwd: input.environment.HOME ?? homedir(),
      env: launch.env
    },
    { onServerRequest: (ask) => answerHeadlessAsk(connection, ask, input.credentials) }
  )
  try {
    const table = readZcodeBuiltinTable(launch.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE ?? null)
    await pushZcodeAccountConfig(connection, table, input.credentials)
    const resumed = await connection.request(
      'session/resume',
      { sessionId: input.providerSessionId },
      { timeoutMs: 20_000, onReply: () => input.signal?.throwIfAborted() }
    )
    const resumedSessionId =
      readString(readRecord(readRecord(resumed)?.session)?.sessionId) ?? input.providerSessionId
    return await input.run({
      resumedSessionId,
      request: async <R>(method: string, params: Record<string, unknown>) => {
        const reply = await connection.request(method, params, {
          timeoutMs: 30_000,
          onReply: () => input.signal?.throwIfAborted()
        })
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
        return reply as R
      }
    })
  } finally {
    await connection.close().catch(() => undefined)
  }
}

function answerHeadlessAsk(
  connection: ZcodeAppServerConnection,
  ask: { method: string; id: number | string },
  credentials: ZcodeChatCredentials | null
): void {
  if (ask.method === 'session/requestRuntimePreferences') {
    connection.respond(ask.id, {
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: false,
      askUserQuestionAutoResolutionEnabled: false
    })
    return
  }
  if (ask.method === 'interaction/requestProviderRuntimeHeaders') {
    if (credentials) {
      connection.respond(ask.id, {
        headersApplied: true,
        requestAuth: { apiKey: credentials.apiKey }
      })
    } else {
      connection.respondWithError(ask.id, -32000, 'no coding plan key is available to Orca')
    }
    return
  }
  connection.respondWithError(ask.id, -32601, `Orca does not answer ${ask.method}`)
}

/** The session's full message list, oldest first, read a page at a time. */
async function readZcodeMessages(
  headless: Pick<HeadlessRun, 'request'>,
  providerSessionId: string
): Promise<{ role: string; messageId: string; synthetic: boolean }[]> {
  const messages: { role: string; messageId: string; synthetic: boolean }[] = []
  let afterMessageId: string | null = null
  for (;;) {
    const page = await headless.request<{ messages?: unknown }>('session/messages', {
      sessionId: providerSessionId,
      ...(afterMessageId ? { afterMessageId } : {}),
      limit: 200
    })
    const rows = Array.isArray(page?.messages) ? page.messages : []
    if (rows.length === 0) {
      return messages
    }
    for (const row of rows) {
      const info = readRecord(readRecord(row)?.info)
      const role = readString(info?.role)
      const messageId = readString(info?.messageId)
      if (role && messageId) {
        // Injected context rows (environment, model, skills, reminders) are user-role rows with
        // a semantics source; a person's prompt never carries one (probed on a live backend).
        const synthetic =
          role === 'user' && readString(readRecord(info?.semantics)?.source) !== null
        messages.push({ role, messageId, synthetic })
      }
    }
    const last = messages.at(-1)?.messageId ?? null
    if (rows.length < 200 || last === null || last === afterMessageId) {
      return messages
    }
    afterMessageId = last
  }
}

async function forkZcodeSession(
  headless: Pick<HeadlessRun, 'request'>,
  providerSessionId: string,
  target: Record<string, unknown>
): Promise<{ forkedSessionId: string; targetMessageId: string | null }> {
  const forked = await headless.request<{
    forkedSessionId?: unknown
    targetMessageId?: unknown
  }>('session/fork', { sessionId: providerSessionId, target })
  const forkedSessionId = readString(forked?.forkedSessionId)
  if (!forkedSessionId) {
    throw new ZcodeConversationCopyRefusedError(
      'provider-refused',
      'zcode answered the fork without a session id'
    )
  }
  return { forkedSessionId, targetMessageId: readString(forked?.targetMessageId) }
}

/**
 * Rewind-to-blank has no fork target zcode accepts (its fork cannot express an empty history),
 * so a null target opens a fresh session instead; a non-null target forks at that message.
 */
async function forkZcodeForRewindHistory(
  headless: Pick<HeadlessRun, 'request' | 'resumedSessionId'>,
  target: Record<string, unknown> | null,
  workspaceCwd: string
): Promise<{ forkedSessionId: string; targetMessageId: string | null }> {
  if (target === null) {
    const created = await headless.request<{ session?: unknown }>('session/create', {
      workspace: { workspacePath: workspaceCwd, workspaceKey: workspaceCwd }
    })
    const fresh = readString(readRecord(readRecord(created)?.session)?.sessionId)
    if (!fresh) {
      throw new ZcodeConversationCopyRefusedError(
        'provider-refused',
        'zcode opened no blank session for the rewind'
      )
    }
    return { forkedSessionId: fresh, targetMessageId: null }
  }
  return forkZcodeSession(headless, headless.resumedSessionId, target)
}

/**
 * Copy the conversation through the selected turn. The anchor is the turn's own input message id:
 * the fork keeps that message plus its reply, so the boundary's opener key lands exactly.
 */
export async function copyZcodeConversation(input: {
  environment: NodeJS.ProcessEnv
  commandSettings?: StructuredAgentCommandSettings
  credentials: ZcodeChatCredentials | null
  providerSessionId: string
  /** The selected turn's opener input message id (checkpoint.rootMessage.uuid). */
  throughMessageId: string | null
  signal?: AbortSignal
}): Promise<ZcodeConversationCopy> {
  try {
    return await withZcodeHeadlessConnection({
      environment: input.environment,
      ...(input.commandSettings ? { commandSettings: input.commandSettings } : {}),
      credentials: input.credentials,
      providerSessionId: input.providerSessionId,
      ...(input.signal ? { signal: input.signal } : {}),
      run: async (headless) => {
        const messages = await readZcodeMessages(headless, headless.resumedSessionId)
        let target: Record<string, unknown> = { kind: 'latestCheckpoint' }
        if (input.throughMessageId) {
          const at = messages.findIndex(
            (message) => message.role === 'user' && message.messageId === input.throughMessageId
          )
          if (at === -1) {
            throw new ZcodeConversationCopyRefusedError(
              'invalid-target',
              'zcode could not find the fork point in its own history'
            )
          }
          // The turn's last message: walk forward past the reply and injected context rows
          // (synthetic user rows) until the next person's prompt opens another turn.
          let last = at
          while (
            last + 1 < messages.length &&
            !(messages[last + 1]!.role === 'user' && !messages[last + 1]!.synthetic)
          ) {
            last += 1
          }
          target = { kind: 'message', messageId: messages[last]!.messageId }
        }
        const forked = await forkZcodeSession(headless, headless.resumedSessionId, target)
        return { sessionId: forked.forkedSessionId }
      }
    })
  } catch (error) {
    throw copyFailure(error)
  }
}

/**
 * Rewind by fork: keep the history strictly before the removed prompt. Anchored on the prompt's
 * own message id, the fork targets the message right before it; a first prompt rewinds to a blank
 * session, since zcode's fork target cannot express an empty history.
 */
export async function forkZcodeForRewind(input: {
  environment: NodeJS.ProcessEnv
  commandSettings?: StructuredAgentCommandSettings
  credentials: ZcodeChatCredentials | null
  /** The session the cut rides; a retained ancestor keeps its rows under its own id. */
  providerSessionId: string
  /** The removed prompt's input message id (beforeMessage.uuid from the host's rewind cut). */
  cutMessageId: string | null
  /** The session the chat resumes after the rewind: the provider handle chain's head. */
  replacesSessionId: string
  /** The workspace a blank-session rewind creates in (the chat's launch directory). */
  workspaceCwd: string
  signal?: AbortSignal
}): Promise<
  { ok: true; fork: AgentSessionRewindFork } | { ok: false; reason: AgentSessionRewindReason }
> {
  try {
    return await withZcodeHeadlessConnection({
      environment: input.environment,
      ...(input.commandSettings ? { commandSettings: input.commandSettings } : {}),
      credentials: input.credentials,
      providerSessionId: input.providerSessionId,
      ...(input.signal ? { signal: input.signal } : {}),
      run: async (headless) => {
        const messages = await readZcodeMessages(headless, headless.resumedSessionId)
        const at = messages.findIndex(
          (message) => message.role === 'user' && message.messageId === input.cutMessageId
        )
        if (at === -1) {
          throw new ZcodeConversationCopyRefusedError(
            'invalid-target',
            'zcode could not find the rewind point in its own history'
          )
        }
        // The kept history ends at the last real message of the previous turn; injected
        // context rows ahead of the removed prompt belong to that prompt's turn, not to it.
        let beforeIndex = at - 1
        while (beforeIndex >= 0 && messages[beforeIndex]!.synthetic) {
          beforeIndex -= 1
        }
        const fork = await forkZcodeForRewindHistory(
          headless,
          beforeIndex < 0 ? null : { kind: 'message', messageId: messages[beforeIndex]!.messageId },
          input.workspaceCwd
        )
        return {
          ok: true,
          fork: {
            sessionId: fork.forkedSessionId,
            sourceSessionId: input.providerSessionId,
            ...(fork.targetMessageId ? { throughEntryId: fork.targetMessageId } : {}),
            replacesSessionId: input.replacesSessionId
          }
        }
      }
    })
  } catch (error) {
    return { ok: false, reason: copyFailure(error).reason }
  }
}

function copyFailure(error: unknown): ZcodeConversationCopyRefusedError {
  if (error instanceof ZcodeConversationCopyRefusedError) {
    return error
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/running/u.test(message)) {
    return new ZcodeConversationCopyRefusedError('busy', message)
  }
  return new ZcodeConversationCopyRefusedError('provider-refused', message)
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}
