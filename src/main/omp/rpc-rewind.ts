import { z } from 'zod'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { decodeOmpRewindTarget, encodeOmpRewindTarget } from '../../shared/omp-rewind-target'
import { parseAgentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../shared/agent-session-journal-types'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { PiRpcSession, PiRpcConnection } from '../pi/rpc-session'
import { readPiEntries } from '../pi/rpc-history-catch-up'
import { piBranchInTree } from '../pi/rpc-history-import'
import type { PiSessionEntry } from '../pi/rpc-history-import'
import { JsonlRpcResponseError, type JsonlRpcRecord } from '../jsonl-rpc/peer'

const customRequestSchema = z.object({
  role: z.literal('custom'),
  customType: z.enum(['skill-prompt', 'collab-prompt']),
  attribution: z.literal('user'),
  timestamp: z.number().finite()
})
const requestSchema = z.union([
  z.object({ role: z.literal('user'), timestamp: z.number().finite() }),
  customRequestSchema
])
const stateSchema = z.object({
  sessionFile: z.string(),
  isSettled: z.literal(true),
  queuedMessageCount: z.literal(0),
  goal: z
    .object({ goal: z.object({ status: z.string() }) })
    .nullable()
    .optional()
})
type Result = Awaited<ReturnType<NonNullable<StructuredAgentSessionAdapter['rewind']>>>

function requestTimestamp(entry: PiSessionEntry): number | undefined {
  const message =
    entry.type === 'message'
      ? entry.message
      : entry.type === 'custom_message'
        ? {
            ...entry,
            role: 'custom',
            timestamp: typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : undefined
          }
        : null
  const parsed = requestSchema.safeParse(message)
  return parsed.success ? parsed.data.timestamp : undefined
}

/** Invalid parameters are rejected before native navigation can change anything. */
export async function supportsOmpRewind(
  connection: Pick<PiRpcConnection, 'request'>
): Promise<boolean> {
  try {
    await connection.request('navigate_tree', { entryId: null }, { timeoutMs: 2_000 })
  } catch (error) {
    return (
      error instanceof JsonlRpcResponseError &&
      error.command === 'navigate_tree' &&
      error.message === 'entryId must be a string'
    )
  }
  return false
}

/** Record the first native user echo in its turn; steering must never replace the opener. */
export class OmpRpcRewind {
  private turn: string | null = null

  constructor(private readonly warn: (error: unknown) => void) {}

  receive(frame: JsonlRpcRecord, session: PiRpcSession): void {
    if (frame.type !== 'message_end') {
      return
    }
    const user = requestSchema.safeParse(frame.message)
    const turn = session.lane.openTurnId
    const sessionFile = session.sessionFile
    if (!user.success || !turn || !sessionFile || turn === this.turn) {
      return
    }
    this.turn = turn
    const providerTurnId = encodeOmpRewindTarget({ sessionFile, timestamp: user.data.timestamp })
    void session.lane
      .drained()
      .then(() => {
        const admission = session.input.events?.tryReviseResolvedItem?.(
          64 * 1024,
          (journal) => {
            let itemId: string | undefined
            journal.visitItems((id, _sequence, body) => {
              if (body.kind === 'turn' && body.turnId === turn) {
                itemId = id
              }
            })
            const body = itemId ? journal.itemBody(itemId) : null
            const identity = itemId ? parseAgentJournalItemKey(itemId) : null
            return identity && body?.kind === 'turn' && !body.providerTurnId
              ? { identity, body: { ...body, providerTurnId } }
              : null
          },
          { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        if (!admission?.accepted) {
          this.warn(new Error('OMP rewind marker was not recorded'))
        }
      })
      .catch(this.warn)
  }
}

export async function rewindOmpSession(
  session: PiRpcSession,
  beforeTurnId: string,
  options: { recover?: boolean; signal?: AbortSignal } = {}
): Promise<Result> {
  const target = decodeOmpRewindTarget(beforeTurnId)
  if (!target) {
    return { ok: false, reason: 'invalid-target' }
  }
  const read = async <T>(promise: Promise<T>): Promise<T> =>
    options.signal ? waitForPromiseWithSignal(promise, options.signal) : promise
  const idle = async () => {
    const parsed = stateSchema.safeParse(await read(session.connection.request('get_state')))
    return (
      parsed.success &&
      parsed.data.sessionFile === session.sessionFile &&
      parsed.data.goal?.goal.status !== 'active' &&
      !session.turns.working &&
      !session.turns.holdsDispatch
    )
  }
  if (!(await idle())) {
    return { ok: false, reason: 'busy' }
  }
  const answer = await read(readPiEntries(session.connection, null))
  const candidates = answer.entries.filter((entry) => {
    const timestamp = requestTimestamp(entry)
    return (
      timestamp !== undefined &&
      ('entryId' in target
        ? entry.id === target.entryId
        : target.sessionFile === session.sessionFile && timestamp === target.timestamp)
    )
  })
  // Timestamps are native correlation evidence only when unique, including abandoned branches.
  if (candidates.length !== 1) {
    return { ok: false, reason: 'invalid-target' }
  }
  const entry = candidates[0]!
  const applied = (): Result => {
    session.history.start({ entry: entry.parentId })
    return { ok: true }
  }
  const branch = piBranchInTree(answer, null)
  if (!branch || branch === 'unknown-claim') {
    return { ok: false, reason: 'proof-mismatch' }
  }
  if (options.recover) {
    if (answer.leafId === entry.parentId) {
      return applied()
    }
    return {
      ok: false,
      reason: branch.path.some((row) => row.id === entry.id)
        ? 'provider-refused'
        : 'outcome-unknown'
    }
  }
  if (!branch.path.some((row) => row.id === entry.id)) {
    return { ok: false, reason: 'invalid-target' }
  }
  const mode = branch.path
    .slice(
      0,
      branch.path.findIndex((row) => row.id === entry.id)
    )
    .findLast((row) => row.type === 'mode_change')
  // Navigation rehydrates historical modes; never restart a historical Goal as a side effect.
  if (mode?.mode === 'goal') {
    return { ok: false, reason: 'busy' }
  }
  if (!(await idle())) {
    return { ok: false, reason: 'busy' }
  }
  options.signal?.throwIfAborted()
  let result: unknown
  try {
    result = await session.connection.request('navigate_tree', {
      entryId: entry.id,
      summarize: false
    })
  } catch (error) {
    if (error instanceof JsonlRpcResponseError) {
      if (error.message === 'Unknown command: navigate_tree') {
        return { ok: false, reason: 'unsupported' }
      }
      const after = await read(readPiEntries(session.connection, null))
      if (after.leafId === entry.parentId) {
        return applied()
      }
      return {
        ok: false,
        reason: after.leafId === answer.leafId ? 'provider-refused' : 'outcome-unknown'
      }
    }
    throw error
  }
  const parsed = z.object({ cancelled: z.boolean(), aborted: z.boolean().optional() }).parse(result)
  if (parsed.cancelled || parsed.aborted) {
    return { ok: false, reason: 'provider-refused' }
  }
  const after = await read(readPiEntries(session.connection, null))
  return after.leafId === entry.parentId ? applied() : { ok: false, reason: 'outcome-unknown' }
}
