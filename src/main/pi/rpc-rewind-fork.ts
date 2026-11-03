import { isAbsolute } from 'node:path'
import { z } from 'zod'
import type {
  AgentSessionRewindFork,
  AgentSessionRewindReason
} from '../../shared/agent-session/lifecycle/agent-session-rewind'
import { JsonlRpcResponseError } from '../jsonl-rpc/peer'
import { readPiEntries } from './rpc-history-catch-up'
import { piBranchInTree, type PiSessionEntry } from './rpc-history-import'
import { piRpcIdle, piRpcStateSchema } from './rpc-protocol'
import type { StructuredRewindForkTarget } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { PiRpcConnection, PiRpcSession } from './rpc-session'

const forkReplySchema = z.looseObject({ cancelled: z.boolean() })

const userEntrySchema = z.looseObject({
  type: z.literal('message'),
  message: z.looseObject({
    role: z.literal('user'),
    content: z.union([
      z.string(),
      z.array(z.looseObject({ type: z.string(), text: z.string().optional() }))
    ])
  })
})

/** Prompt text of a user entry, its text parts joined as Orca joins a prompt's text blocks. */
export function piUserEntryText(entry: PiSessionEntry): string | null {
  const parsed = userEntrySchema.safeParse(entry)
  if (!parsed.success) {
    return null
  }
  const { content } = parsed.data.message
  return typeof content === 'string'
    ? content
    : content.flatMap((part) => (part.type === 'text' && part.text ? [part.text] : [])).join('\n')
}

/** Pi forks before the removed prompts' text, so sent messages need no Pi entry id to be offered. */
export const PI_REWIND_SUPPORT = { supported: true, cutsAtPrompt: true } as const

type PiRewindFork =
  | { ok: true; fork: AgentSessionRewindFork }
  | { ok: false; reason: AgentSessionRewindReason }

/** The branch entry Pi forks before, once Pi's branch ends with exactly the prompts the chat removes. */
async function readPiRewindTarget(
  connection: Pick<PiRpcConnection, 'request'>,
  target: { sessionId: string; prompts: readonly string[] }
): Promise<{ ok: true; entry: PiSessionEntry } | { ok: false; reason: AgentSessionRewindReason }> {
  const state = piRpcStateSchema.parse(await connection.request('get_state', {}))
  if (state.sessionFile !== target.sessionId) {
    return { ok: false, reason: 'proof-mismatch' }
  }
  if (!piRpcIdle(state)) {
    return { ok: false, reason: 'busy' }
  }
  const branch = piBranchInTree(await readPiEntries(connection, null), null)
  if (!branch || branch === 'unknown-claim') {
    return { ok: false, reason: 'provider-refused' }
  }
  const prompts = branch.path.flatMap((entry) => {
    const text = piUserEntryText(entry)
    return text === null ? [] : [{ entry, text }]
  })
  const removed = prompts.slice(prompts.length - target.prompts.length)
  const entry = removed[0]?.entry
  return entry &&
    removed.length === target.prompts.length &&
    removed.every(({ text }, index) => text === target.prompts[index])
    ? { ok: true, entry }
    : { ok: false, reason: 'proof-mismatch' }
}

/** Restart from the recorded conversation rather than keep a child on an unrecorded fork. */
async function closeOnUnrecordedFork(
  session: { close(): Promise<unknown> },
  error: unknown
): Promise<never> {
  // The fork's own failure is what the rewind reports, even when closing fails too.
  await session.close().catch(() => undefined)
  throw error
}

/** Rewind with Pi's own `fork`, which leaves the running Pi on a new session file. */
export async function forkPiRpcSessionForRewind(
  session: { connection: Pick<PiRpcConnection, 'request'>; close(): Promise<unknown> },
  target: { sessionId: string; prompts: readonly string[] }
): Promise<PiRewindFork> {
  const { connection } = session
  // Nothing has changed yet, so a failed read refuses cleanly.
  const read = await readPiRewindTarget(connection, target).catch(() => ({
    ok: false as const,
    reason: 'provider-refused' as const
  }))
  if (!read.ok) {
    return read
  }
  const first = read.entry
  let reply: z.infer<typeof forkReplySchema>
  try {
    reply = forkReplySchema.parse(await connection.request('fork', { entryId: first.id }))
  } catch (error) {
    if (error instanceof JsonlRpcResponseError) {
      return { ok: false, reason: 'provider-refused' }
    }
    // Pi may have forked before the reply failed, so the outcome is unknown.
    return closeOnUnrecordedFork(session, error)
  }
  if (reply.cancelled) {
    return { ok: false, reason: 'provider-refused' }
  }
  try {
    const forked = piRpcStateSchema.parse(await connection.request('get_state', {}))
    if (!isAbsolute(forked.sessionFile) || forked.sessionFile === target.sessionId) {
      throw new Error('Pi did not report its rewind fork')
    }
    return {
      ok: true,
      fork: {
        sessionId: forked.sessionFile,
        sourceSessionId: target.sessionId,
        ...(first.parentId === null ? {} : { throughEntryId: first.parentId }),
        // Pi writes the fork itself; one that keeps no messages is saved with its next answer.
        materialized: true,
        replacesSessionId: target.sessionId
      }
    }
  } catch (error) {
    return closeOnUnrecordedFork(session, error)
  }
}

/** Fork only through the live child of the rewind's own fence, and only at prompt text. */
export async function forkLivePiRpcSessionForRewind(
  session: PiRpcSession | undefined,
  input: { fence: number; beforeMessage: StructuredRewindForkTarget }
): Promise<PiRewindFork> {
  const { beforeMessage } = input
  if (
    !('prompts' in beforeMessage) ||
    !session ||
    session.input.fence !== input.fence ||
    session.connection.closed ||
    !session.openedLink
  ) {
    return { ok: false, reason: 'invalid-target' }
  }
  return forkPiRpcSessionForRewind(session, beforeMessage)
}
