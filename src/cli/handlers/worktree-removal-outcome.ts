import { setTimeout as delay } from 'node:timers/promises'
import type {
  RuntimeWorktreeRemovalState,
  RuntimeWorktreeRemoveResult
} from '../../shared/runtime-types'
import { isRecoverableRemoteRuntimeConnectionError } from '../../shared/remote-runtime-client-error-classification'
import { RuntimeClientError, type RuntimeClient, type RuntimeRpcSuccess } from '../runtime-client'
import { RuntimeRequestNotSentError } from '../runtime/types'

export type WorktreeRemovalRequest = {
  worktree: string
  hostId: string
  force: boolean
  allowUnverifiedPtyStop: boolean
  runHooks: boolean
  allowFailedArchiveHook: boolean
}

// Why short first: most deletes finish in well under a second; a long one settles to 1 s polls.
const POLL_DELAYS_MS = [100, 250, 500, 1_000]
// About 3 s of an unreachable app before giving up.
const DROPPED_CONNECTIONS_BEFORE_GIVING_UP = 5

// Why jittered: a burst of CLIs dropped together at the host's connection limit must not retry together.
function pollDelay(attempt: number): Promise<unknown> {
  const base = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)]
  return delay(Math.round(base * (0.5 + Math.random())))
}

/**
 * Removes the worktree and answers with the delete's outcome: `removed: true` only once Git has
 * finished, a non-zero error if it failed. A background delete is followed by polling
 * `worktree.removalState`, with no total limit, so a long delete is never cut off and the wait
 * holds no connection on the host. A host that predates that read answers on acceptance; that is
 * reported as not yet removed rather than as a removal.
 */
export async function removeWorktreeAndWait(
  client: RuntimeClient,
  request: WorktreeRemovalRequest & { worktreeId: string }
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemoveResult>> {
  const { worktreeId } = request
  const response = await sendRemoval(client, request)
  if (!response.result.removing) {
    return response
  }
  let unreachable = 0
  for (let attempt = 0; ; attempt += 1) {
    await pollDelay(attempt)
    const read = await readRemovalState(client, worktreeId, request.hostId).then(
      (reply) => ({ state: reply?.result }),
      (error: unknown) => ({ error })
    )
    if ('error' in read) {
      unreachable = isDroppedConnection(read.error) ? unreachable + 1 : 0
      // Why retry: a socket at its connection limit, or a network blip on a paired connection, drops
      // a connection the same way a gone app does.
      if (unreachable > 0 && unreachable < DROPPED_CONNECTIONS_BEFORE_GIVING_UP) {
        continue
      }
      throw unconfirmedRemovalError(request.worktree, read.error)
    }
    unreachable = 0
    const { state } = read
    if (!state) {
      return { ...response, result: { ...response.result, removed: false } }
    }
    if (state.state === 'removing') {
      continue
    }
    if (state.state === 'failed') {
      throw new RuntimeClientError('worktree_removal_failed', state.message)
    }
    if (state.state === 'present') {
      throw new RuntimeClientError(
        'worktree_removal_failed',
        `Orca did not remove ${request.worktree}: the workspace is still there and nothing is deleting it. Check \`orca worktree show --worktree ${request.worktree}\` before trying again.`
      )
    }
    const { removing: _removing, ...accepted } = response.result
    return {
      ...response,
      result: {
        ...accepted,
        removed: true,
        ...(state.preservedBranch ? { preservedBranch: state.preservedBranch } : {})
      }
    }
  }
}

export function formatWorktreeRemoval(value: RuntimeWorktreeRemoveResult): string {
  return value.removing
    ? 'removed: false\nOrca accepted the removal and is still deleting the checkout; this Orca version does not report when it finishes.'
    : `removed: ${value.removed}`
}

/**
 * Sends `worktree.rm`. A request that provably never left is sent again. Any other dropped
 * connection hides whether the host got it (a socket at its connection limit drops one that was
 * written, unread), so the host's own state decides: a delete it accepted is waited on and never
 * sent again; one it is not running is sent again, unless the archive hook may already have run.
 */
async function sendRemoval(
  client: RuntimeClient,
  request: WorktreeRemovalRequest & { worktreeId: string }
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemoveResult>> {
  const { worktreeId: _worktreeId, ...params } = request
  for (let attempt = 1; ; attempt += 1) {
    const sent = await client.call<RuntimeWorktreeRemoveResult>('worktree.rm', params).then(
      (response) => ({ response }),
      (error: unknown) => ({ error })
    )
    if ('response' in sent) {
      return sent.response
    }
    if (!isDroppedConnection(sent.error)) {
      throw sent.error
    }
    if (sent.error instanceof RuntimeRequestNotSentError) {
      if (attempt === DROPPED_CONNECTIONS_BEFORE_GIVING_UP) {
        throw sent.error
      }
      await pollDelay(attempt - 1)
      continue
    }
    const reply = await readStateAfterDroppedRequest(client, request, sent.error)
    if (reply.result.state !== 'present') {
      return { ...reply, result: { removed: true, removing: true } }
    }
    if (request.runHooks) {
      throw new RuntimeClientError(
        'worktree_removal_unconfirmed',
        `Orca did not confirm it received the removal of ${request.worktree}, and the workspace is still there. It was not sent again because its archive hook may already have run; run the command again to remove it.`
      )
    }
    if (attempt === DROPPED_CONNECTIONS_BEFORE_GIVING_UP) {
      throw sent.error
    }
  }
}

/** Asks the host what became of a request whose reply was lost; never sends it again itself. */
async function readStateAfterDroppedRequest(
  client: RuntimeClient,
  request: WorktreeRemovalRequest & { worktreeId: string },
  dropped: unknown
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemovalState>> {
  for (let attempt = 0; ; attempt += 1) {
    await pollDelay(attempt)
    const read = await readRemovalState(client, request.worktreeId, request.hostId).then(
      (reply) => ({ reply }),
      (error: unknown) => ({ error })
    )
    if (!('error' in read)) {
      if (!read.reply) {
        // An older host can't say whether it got the request.
        throw dropped
      }
      return read.reply
    }
    if (!isDroppedConnection(read.error) || attempt + 1 === DROPPED_CONNECTIONS_BEFORE_GIVING_UP) {
      throw new RuntimeClientError(
        'worktree_removal_unconfirmed',
        `Orca stopped responding before confirming the removal of ${request.worktree}. If it received the request, the removal finishes when Orca runs again; once Orca responds, run \`orca worktree rm --worktree ${request.worktree}\` again to confirm it.`,
        { cause: read.error instanceof Error ? read.error.message : String(read.error) }
      )
    }
  }
}

/** Undefined from a host that predates the read. */
async function readRemovalState(
  client: RuntimeClient,
  worktreeId: string,
  hostId: string
): Promise<RuntimeRpcSuccess<RuntimeWorktreeRemovalState> | undefined> {
  try {
    return await client.call<RuntimeWorktreeRemovalState>('worktree.removalState', {
      worktreeId,
      hostId
    })
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      return undefined
    }
    throw error
  }
}

// Why not timeouts: a request that waited out its whole timeout already says the app stopped.
function isDroppedConnection(error: unknown): boolean {
  return (
    error instanceof RuntimeClientError &&
    error.code !== 'runtime_timeout' &&
    error.code !== 'timeout' &&
    isRecoverableRemoteRuntimeConnectionError(error)
  )
}

// Why not a failure: the host owns the delete and keeps it running whatever happens to this read.
function unconfirmedRemovalError(worktree: string, error: unknown): RuntimeClientError {
  const stopped =
    error instanceof RuntimeClientError && isRecoverableRemoteRuntimeConnectionError(error)
  return new RuntimeClientError(
    'worktree_removal_unconfirmed',
    `Orca accepted the removal of ${worktree}, but ${stopped ? 'the Orca app stopped responding' : 'could not report how it ended'}. The removal may still be running; once Orca responds, run \`orca worktree rm --worktree ${worktree}\` again to wait for it.`,
    { cause: error instanceof Error ? error.message : String(error) }
  )
}
