// Ties worktree checkpoints to chats: one snapshot before each turn a message opens, keyed by that
// message's journal item, so "Rewind to here" can put the files back as they were when it was sent.
// Capture failures never block or fail a send; they only mean that message has no checkpoint.

import { createHash, randomBytes } from 'node:crypto'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  AGENT_SESSION_CHECKPOINT_UNDO_ID,
  agentSessionCheckpointRefusalMessage,
  type AgentSessionCheckpointPreview,
  type AgentSessionCheckpointRestoreResult
} from '../../../../shared/agent-session/lifecycle/agent-session-checkpoint'
import {
  CHECKPOINT_REF_ROOT,
  type CheckpointRepo,
  openCheckpointRepo,
  WorktreeCheckpointError
} from '../../../git/checkpoints/worktree-checkpoint-git'
import {
  captureWorktreeCheckpoint,
  readWorktreeCheckpoint,
  type WorktreeCheckpoint
} from '../../../git/checkpoints/worktree-checkpoint-snapshot'
import {
  previewWorktreeRestore,
  restoreWorktreeCheckpoint
} from '../../../git/checkpoints/worktree-checkpoint-restore'
import { pruneCheckpointRefs } from '../../../git/checkpoints/worktree-checkpoint-retention'
import type { StructuredAgentSessionLogger } from '../host/structured-agent-session-logger'
import type { StructuredAgentSessionDeliveryLoopDeps } from '../delivery/structured-agent-session-delivery-loop-deps'
import type { StructuredAgentSessionHostDeps } from '../host/structured-agent-session-host-types'

export const TURN_CHECKPOINTS_KEPT = 50
export const UNDO_CHECKPOINTS_KEPT = 10
export const CHECKPOINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** A worktree too large to snapshot in this long sends without a checkpoint. */
export const CHECKPOINT_CAPTURE_TIMEOUT_MS = 15_000

export type AgentSessionCheckpointsDeps = {
  record: (sessionId: string) => AgentSessionRecord | null
  resolveWorkspacePath?: (workspaceId: string) => Promise<string>
  /** True while the chat has a turn running; restores wait for it to finish. */
  isBusy: (sessionId: string) => boolean
  logger: StructuredAgentSessionLogger
  now: () => number
  openRepo?: (directory: string) => Promise<CheckpointRepo>
}

export type AgentSessionCheckpoints = ReturnType<typeof createAgentSessionCheckpoints>

/** Ref-safe and stable: readable ids pass through, anything else is hashed. */
function refComponent(value: string): string {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/.test(value) && !value.endsWith('.lock')
    ? value
    : createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function sessionPrefix(sessionId: string): string {
  return `${CHECKPOINT_REF_ROOT}${refComponent(sessionId)}/`
}

function turnRef(sessionId: string, itemId: string): string {
  return `${sessionPrefix(sessionId)}turn/${createHash('sha256').update(itemId).digest('hex').slice(0, 32)}`
}

function refuse(reason: Parameters<typeof agentSessionCheckpointRefusalMessage>[0]): never {
  throw new Error(agentSessionCheckpointRefusalMessage(reason))
}

// One git writer per worktree at a time across every chat in this process: a capture never
// interleaves with a restore, so a send after a rewind snapshots the restored files.
const queues = new Map<string, Promise<unknown>>()
function serialize<T>(root: string, task: () => Promise<T>): Promise<T> {
  const run = (queues.get(root) ?? Promise.resolve()).then(task, task)
  const tail = run.catch(() => undefined)
  queues.set(root, tail)
  void tail.then(() => queues.get(root) === tail && queues.delete(root))
  return run
}

export function createAgentSessionCheckpoints(deps: AgentSessionCheckpointsDeps) {
  const open = deps.openRepo ?? ((directory: string) => openCheckpointRepo(directory))
  const repoFor = async (sessionId: string): Promise<CheckpointRepo | null> => {
    const record = deps.record(sessionId)
    // WSL worktrees route git through another filesystem; their temp index paths don't map.
    if (!record || record.location.wslDistro) {
      return null
    }
    const directory =
      record.launchDirectory ?? (await deps.resolveWorkspacePath?.(record.location.workspaceId))
    return directory ? open(directory) : null
  }

  const captureTurn = async (
    sessionId: string,
    itemId: string,
    signal?: AbortSignal
  ): Promise<void> => {
    const started = deps.now()
    try {
      const repo = await repoFor(sessionId)
      if (!repo) {
        return
      }
      await serialize(repo.root, async () => {
        await captureWorktreeCheckpoint(
          repo,
          turnRef(sessionId, itemId),
          { kind: 'turn', createdAt: deps.now(), labels: { sessionId, itemId } },
          { signal, timeoutMs: CHECKPOINT_CAPTURE_TIMEOUT_MS }
        )
        await pruneCheckpointRefs(repo, {
          prefix: `${sessionPrefix(sessionId)}turn/`,
          keep: TURN_CHECKPOINTS_KEPT,
          maxAgeMs: CHECKPOINT_MAX_AGE_MS,
          now: deps.now()
        })
      })
    } catch (error) {
      if (error instanceof WorktreeCheckpointError && error.reason === 'not-a-repo') {
        return
      }
      deps.logger.warn('[agent-session] turn checkpoint skipped', {
        scope: 'checkpoint-capture',
        sessionId,
        elapsedMs: deps.now() - started,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const target = async (
    sessionId: string,
    ref: string
  ): Promise<{ repo: CheckpointRepo; checkpoint: WorktreeCheckpoint } | null> => {
    const repo = await repoFor(sessionId)
    const checkpoint = repo ? await readWorktreeCheckpoint(repo, ref) : null
    return repo && checkpoint ? { repo, checkpoint } : null
  }

  const preview = async (
    sessionId: string,
    itemId: string
  ): Promise<AgentSessionCheckpointPreview> => {
    try {
      const found = await target(sessionId, turnRef(sessionId, itemId))
      if (!found) {
        return { available: false, reason: 'none' }
      }
      const { changes, headMoved } = await serialize(found.repo.root, () =>
        previewWorktreeRestore(found.repo, found.checkpoint)
      )
      return {
        available: true,
        changedFiles: changes.length,
        headMoved,
        createdAt: found.checkpoint.createdAt
      }
    } catch (error) {
      if (error instanceof WorktreeCheckpointError && error.reason === 'not-a-repo') {
        return { available: false, reason: 'not-a-repo' }
      }
      deps.logger.warn('[agent-session] checkpoint preview failed', {
        scope: 'checkpoint-preview',
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      })
      return { available: false, reason: 'unavailable' }
    }
  }

  const restoreRef = async (
    sessionId: string,
    ref: string
  ): Promise<AgentSessionCheckpointRestoreResult> => {
    if (deps.isBusy(sessionId)) {
      refuse('busy')
    }
    const found = await target(sessionId, ref).catch((error: unknown) => {
      if (error instanceof WorktreeCheckpointError && error.reason === 'not-a-repo') {
        refuse('not-a-repo')
      }
      throw error
    })
    if (!found) {
      refuse('none')
    }
    const now = deps.now()
    const undoId = `${now}-${randomBytes(4).toString('hex')}`
    try {
      const result = await serialize(found.repo.root, () =>
        restoreWorktreeCheckpoint(found.repo, found.checkpoint, {
          ref: `${sessionPrefix(sessionId)}undo/${undoId}`,
          now,
          labels: { sessionId }
        })
      )
      void pruneCheckpointRefs(found.repo, {
        prefix: `${sessionPrefix(sessionId)}undo/`,
        keep: UNDO_CHECKPOINTS_KEPT,
        maxAgeMs: CHECKPOINT_MAX_AGE_MS,
        now
      }).catch(() => undefined)
      return { changedFiles: result.changes.length, headMoved: result.headMoved, undoId }
    } catch (error) {
      if (
        error instanceof WorktreeCheckpointError &&
        (error.reason === 'merge-conflicts' ||
          error.reason === 'blocked-path' ||
          error.reason === 'unsafe-path')
      ) {
        refuse(error.reason)
      }
      throw error
    }
  }

  return {
    captureTurn,
    preview,
    restore: (sessionId: string, itemId: string) =>
      restoreRef(sessionId, turnRef(sessionId, itemId)),
    undo: async (sessionId: string, undoId: string) => {
      if (!AGENT_SESSION_CHECKPOINT_UNDO_ID.test(undoId)) {
        refuse('none')
      }
      return restoreRef(sessionId, `${sessionPrefix(sessionId)}undo/${undoId}`)
    }
  }
}

/** The snapshot a send takes before its message opens a turn; never throws. */
export function structuredAgentSessionTurnCheckpoint(
  deps: Pick<
    StructuredAgentSessionDeliveryLoopDeps,
    'record' | 'resolveWorkspacePath' | 'logger' | 'now'
  >,
  sessionId: string
): (itemId: string, signal?: AbortSignal) => Promise<void> {
  const { captureTurn } = createAgentSessionCheckpoints({
    record: deps.record,
    ...(deps.resolveWorkspacePath ? { resolveWorkspacePath: deps.resolveWorkspacePath } : {}),
    isBusy: () => false,
    logger: deps.logger,
    now: deps.now
  })
  return (itemId, signal) => captureTurn(sessionId, itemId, signal)
}

type CheckpointHost = {
  deps: Pick<StructuredAgentSessionHostDeps, 'store' | 'resolveWorkspacePath' | 'logger' | 'now'>
  readStatusSummary: (sessionId: string) => { status: string | null } | undefined
}
const hostCheckpoints = new WeakMap<CheckpointHost, AgentSessionCheckpoints>()

/** Preview, restore and undo for a host's chats; a restore waits for a running turn to end. */
export function hostAgentSessionCheckpoints(host: CheckpointHost): AgentSessionCheckpoints {
  let checkpoints = hostCheckpoints.get(host)
  if (!checkpoints) {
    const { deps } = host
    checkpoints = createAgentSessionCheckpoints({
      record: (sessionId) => deps.store.getRecord(sessionId),
      ...(deps.resolveWorkspacePath ? { resolveWorkspacePath: deps.resolveWorkspacePath } : {}),
      isBusy: (sessionId) => host.readStatusSummary(sessionId)?.status === 'working',
      logger: deps.logger,
      now: () => deps.now?.() ?? Date.now()
    })
    hostCheckpoints.set(host, checkpoints)
  }
  return checkpoints
}
