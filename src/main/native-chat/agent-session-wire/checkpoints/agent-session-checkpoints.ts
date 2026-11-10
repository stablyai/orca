// Ties worktree checkpoints to chats: one snapshot before each turn a message opens, keyed by that
// message's journal item, so "Rewind to here" can put the files back as they were when it was sent.
// Capture failures never block or fail a send; they only mean that message has no checkpoint.

import { createHash, randomBytes } from 'node:crypto'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import {
  AGENT_SESSION_CHECKPOINT_UNDO_ID,
  agentSessionCheckpointPartialMessage,
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
import { markTurnStarting, serialize, startingTurns } from './agent-session-checkpoint-queue'

export const TURN_CHECKPOINTS_KEPT = 50
export const UNDO_CHECKPOINTS_KEPT = 10
export const CHECKPOINT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** A worktree too large to snapshot in this long sends without a checkpoint. */
export const CHECKPOINT_CAPTURE_TIMEOUT_MS = 15_000

export type AgentSessionCheckpointsDeps = {
  record: (sessionId: string) => AgentSessionRecord | null
  resolveWorkspacePath?: (workspaceId: string) => Promise<string>
  /** True while any chat in this chat's worktree has a turn running; restores refuse then. */
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

/** Something else in the workspace that may write files: a terminal agent, say. */
/** Gets the worktree root the restore would write. */
export type AgentSessionWorkspaceBusy = (root: string) => Promise<boolean>

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
  ): Promise<() => void> => {
    const started = deps.now()
    let release = () => {}
    try {
      const repo = await repoFor(sessionId)
      if (!repo) {
        return release
      }
      release = markTurnStarting(repo.root)
      await serialize(repo.root, async () => {
        await captureWorktreeCheckpoint(
          repo,
          turnRef(sessionId, itemId),
          {
            kind: 'turn',
            createdAt: deps.now(),
            labels: { sessionId, itemId }
          },
          { signal, timeoutMs: CHECKPOINT_CAPTURE_TIMEOUT_MS }
        )
        await pruneCheckpointRefs(repo, {
          prefix: `${sessionPrefix(sessionId)}turn/`,
          keep: TURN_CHECKPOINTS_KEPT,
          maxAgeMs: CHECKPOINT_MAX_AGE_MS,
          now: deps.now(),
          protect: [turnRef(sessionId, itemId)]
        })
      })
    } catch (error) {
      if (!(error instanceof WorktreeCheckpointError && error.reason === 'not-a-repo')) {
        deps.logger.warn('[agent-session] turn checkpoint skipped', {
          scope: 'checkpoint-capture',
          sessionId,
          elapsedMs: deps.now() - started,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    return release
  }

  const target = async (
    sessionId: string,
    ref: string
  ): Promise<{
    repo: CheckpointRepo
    checkpoint: WorktreeCheckpoint
  } | null> => {
    const repo = await repoFor(sessionId)
    const checkpoint = repo ? await readWorktreeCheckpoint(repo, ref) : null
    return repo && checkpoint ? { repo, checkpoint } : null
  }

  const preview = async (
    sessionId: string,
    itemId: string,
    workspaceBusy?: AgentSessionWorkspaceBusy
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
        createdAt: found.checkpoint.createdAt,
        busy:
          deps.isBusy(sessionId) ||
          (startingTurns.get(found.repo.root) ?? 0) > 0 ||
          ((await workspaceBusy?.(found.repo.root).catch(() => false)) ?? false)
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
    ref: string,
    workspaceBusy?: AgentSessionWorkspaceBusy
  ): Promise<AgentSessionCheckpointRestoreResult> => {
    const repo = await repoFor(sessionId).catch((error: unknown) => {
      if (error instanceof WorktreeCheckpointError && error.reason === 'not-a-repo') {
        refuse('not-a-repo')
      }
      throw error
    })
    if (!repo) {
      refuse('none')
    }
    const now = deps.now()
    const undoId = `${now}-${randomBytes(4).toString('hex')}`
    const undoRef = `${sessionPrefix(sessionId)}undo/${undoId}`
    try {
      // Look up and check busy inside the queue: a capture queued first runs first, and the turn
      // it starts must make this restore refuse rather than rewrite files under a working agent.
      const result = await serialize(repo.root, async () => {
        if (
          deps.isBusy(sessionId) ||
          (startingTurns.get(repo.root) ?? 0) > 0 ||
          (await workspaceBusy?.(repo.root))
        ) {
          refuse('busy')
        }
        const checkpoint = await readWorktreeCheckpoint(repo, ref)
        if (!checkpoint) {
          refuse('none')
        }
        return restoreWorktreeCheckpoint(repo, checkpoint, {
          ref: undoRef,
          now,
          labels: { sessionId }
        })
      })
      void pruneCheckpointRefs(repo, {
        prefix: `${sessionPrefix(sessionId)}undo/`,
        keep: UNDO_CHECKPOINTS_KEPT,
        maxAgeMs: CHECKPOINT_MAX_AGE_MS,
        now,
        protect: [undoRef]
      }).catch(() => undefined)
      return {
        changedFiles: result.changes.length,
        headMoved: result.headMoved,
        undoId
      }
    } catch (error) {
      if (error instanceof WorktreeCheckpointError && error.reason === 'partial') {
        throw new Error(agentSessionCheckpointPartialMessage(undoId))
      }
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
    restore: (sessionId: string, itemId: string, workspaceBusy?: AgentSessionWorkspaceBusy) =>
      restoreRef(sessionId, turnRef(sessionId, itemId), workspaceBusy),
    undo: async (sessionId: string, undoId: string, workspaceBusy?: AgentSessionWorkspaceBusy) => {
      if (!AGENT_SESSION_CHECKPOINT_UNDO_ID.test(undoId)) {
        refuse('none')
      }
      return restoreRef(sessionId, `${sessionPrefix(sessionId)}undo/${undoId}`, workspaceBusy)
    }
  }
}
