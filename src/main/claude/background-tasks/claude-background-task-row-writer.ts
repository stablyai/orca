import { CLAUDE_BACKGROUND_TASK_SILENT_REFRESH_SUBTYPES } from './claude-background-task-frames'
import type { ClaudeTaskInvocations } from './claude-task-invocations'
import { claudeBackgroundTaskToolUseId } from './claude-background-task-row-lifecycle'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type {
  StructuredAgentSessionEventSink,
  StructuredAgentSessionSinkAdmission
} from '../../native-chat/agent-session-wire/journal-ingress/structured-agent-session-event-sink'
import type { ClaudeBackgroundTaskRow } from './claude-background-task-row-lifecycle'
import {
  ClaudeBackgroundTaskIdentityResolver,
  writeClaudeBackgroundTaskRow
} from './claude-background-task-row-journal'

const MAX_PENDING_TASK_WRITES = 512

export class ClaudeBackgroundTaskRowWriter {
  private readonly pending = new Map<
    string,
    { id: string; row: ClaudeBackgroundTaskRow; lifecycle: boolean }
  >()
  private readonly identities = new ClaudeBackgroundTaskIdentityResolver()

  constructor(
    private readonly sink: StructuredAgentSessionEventSink,
    private readonly turnScope: () => AgentJournalTurnScope,
    private readonly onPersistenceFailure?: (error: Error) => void
  ) {}

  write(
    id: string,
    row: ClaudeBackgroundTaskRow,
    beforeAppend?: () => void,
    lifecycle = false
  ): void {
    const admission = writeClaudeBackgroundTaskRow(
      this.sink,
      this.identities,
      id,
      row,
      this.turnScope,
      beforeAppend,
      lifecycle
    )
    const key = JSON.stringify([id, row.toolUseId ?? null, row.generation])
    if (admission.accepted) {
      this.pending.delete(key)
    } else if (admission.reason === 'backpressure') {
      if (!this.pending.has(key) && this.pending.size >= MAX_PENDING_TASK_WRITES) {
        this.pending.clear()
        this.onPersistenceFailure?.(
          new Error('claude background task journal retry capacity exhausted')
        )
        return
      }
      this.pending.set(key, { id, row, lifecycle })
    } else if (admission.reason === 'failed') {
      this.onPersistenceFailure?.(new Error('claude background task journal sink failed'))
    }
  }

  /** Replays bounded row obligations before provider reading resumes. */
  retryPendingWrites(): StructuredAgentSessionSinkAdmission {
    for (const [key, pending] of this.pending) {
      const admission = writeClaudeBackgroundTaskRow(
        this.sink,
        this.identities,
        pending.id,
        pending.row,
        this.turnScope,
        undefined,
        pending.lifecycle
      )
      if (!admission.accepted) {
        if (admission.reason !== 'backpressure') {
          this.pending.clear()
          if (admission.reason === 'failed') {
            this.onPersistenceFailure?.(new Error('claude background task journal sink failed'))
          }
        }
        return admission
      }
      this.pending.delete(key)
    }
    return { accepted: true }
  }

  settlePendingWrites(): void {
    for (const pending of this.pending.values()) {
      pending.lifecycle = true
    }
    this.retryPendingWrites()
  }

  dispose(): void {
    this.pending.clear()
    this.identities.clear()
  }
}

export function createClaudeBackgroundTaskTurnOpener(
  openOutputTurn: ((frame: Record<string, unknown>, observedAt: number) => void) | undefined,
  invocations: ClaudeTaskInvocations
) {
  return (
    journaling: { frame: Record<string, unknown>; observedAt: number } | null,
    open: boolean,
    id: string | null,
    row?: ClaudeBackgroundTaskRow
  ): (() => void) => {
    const frame = journaling?.frame
    const invocation =
      row?.invocation ??
      (frame && id !== null
        ? (invocations.selection(frame, id)?.invocation ??
          invocations.get(id, claudeBackgroundTaskToolUseId(frame)))
        : undefined)
    return () => {
      // Task inventory from a known child cannot assert execution of the root.
      const subtype = frame?.subtype
      if (
        journaling &&
        open &&
        invocation?.parentTaskId === undefined &&
        (typeof subtype !== 'string' ||
          !CLAUDE_BACKGROUND_TASK_SILENT_REFRESH_SUBTYPES.has(subtype))
      ) {
        openOutputTurn?.(journaling.frame, journaling.observedAt)
      }
    }
  }
}
