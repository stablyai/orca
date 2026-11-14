import { applyJournalForkStagePage } from './journal-fork-stage-page'
import { registerJournalForkStages, type Stage } from './journal-fork-stage-state'
import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type { JournalWriterTarget, JournalWriterCommand } from './journal-writer-command'
import type { JournalReplacementItem } from './context-epochs/journal-epoch-replacement'
import type { NativeCopyOrigin } from './context-epochs/journal-history-origin'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { assertJournalFence } from './writing/journal-write-guards'
import { validateJournalForkSource, type JournalForkSourceProof } from './journal-fork-source-proof'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'

export type JournalForkStageBegin = {
  target: JournalWriterTarget
  identity: AgentSessionJournalIdentity
  fence: number
  operationId: string
  fingerprint: string
  source: JournalForkSourceProof
  historyOrigin?: NativeCopyOrigin
}
export type JournalForkInstall = { token: string; count: number; lastItemId: string | null }
export type JournalForkStageOperation =
  | { kind: 'fork-stage-begin'; input: JournalForkStageBegin }
  | {
      kind: 'fork-stage-page'
      token: string
      ordinal: number
      items: readonly JournalReplacementItem[]
    }
  | { kind: 'fork-abort'; token: string }
  | { kind: 'fork-source-hold'; sessionId: string }
  | { kind: 'fork-source-release'; token: string }
export type JournalForkStageResult =
  | { token: string }
  | { accepted: number; auxiliary: boolean }
  | null

/** Disposable stages stay private; mutable progress is adopted only after the outer COMMIT. */
export class JournalForkStages {
  private live = new Map<string, Stage>()
  private sources = new Map<string, string>()
  private committed = { stages: new Map<string, Stage>(), sources: new Map<string, string>() }
  constructor(
    private readonly db: Database.Database,
    private readonly stateDirectory: string
  ) {
    registerJournalForkStages(db, this)
  }
  epochs(sessionId: string): string[] {
    return [...this.live.values()]
      .filter((stage) => stage.target.sessionId === sessionId)
      .map((stage) => stage.epoch)
  }
  checkpoint() {
    return { stages: new Map(this.live), sources: new Map(this.sources) }
  }
  rollback(checkpoint = this.committed): void {
    this.live = new Map(checkpoint.stages)
    this.sources = new Map(checkpoint.sources)
  }
  acknowledge(): void {
    this.committed = this.checkpoint()
  }
  holdsAttachments(sessionId: string): boolean {
    return this.holds(sessionId) || [...this.sources.values()].includes(sessionId)
  }
  holds(sessionId: string, epoch?: string): boolean {
    return [...this.live.values()].some(
      (stage) =>
        stage.target.sessionId === sessionId && (epoch === undefined || stage.epoch === epoch)
    )
  }
  apply(operation: JournalForkStageOperation, now: number): JournalForkStageResult {
    if (operation.kind === 'fork-source-hold') {
      const token = randomUUID()
      this.sources.set(token, operation.sessionId)
      return { token }
    }
    if (operation.kind === 'fork-source-release') {
      this.sources.delete(operation.token)
      return null
    }
    if (operation.kind === 'fork-stage-begin') {
      return this.begin(operation.input)
    }
    const stage = this.live.get(operation.token)
    if (!stage) {
      if (operation.kind === 'fork-abort') {
        return null
      }
      throw new Error('fork stage is no longer owned')
    }
    if (operation.kind === 'fork-abort') {
      this.live.delete(stage.token)
      return null
    }
    if (operation.ordinal !== stage.count || operation.items.length > 64) {
      throw new Error('fork page continuation does not match its owner')
    }
    const { next, ...result } = applyJournalForkStagePage(
      this.db,
      this.stateDirectory,
      stage,
      operation,
      now
    )
    this.live.set(next.token, next)
    return result
  }

  install(command: JournalWriterCommand, installation: JournalForkInstall): JournalWriterCommand {
    const stage = this.live.get(installation.token)
    if (
      !stage ||
      stage.auxiliary ||
      stage.count !== installation.count ||
      stage.lastItemId !== installation.lastItemId ||
      stage.target.sessionId !== command.target.sessionId ||
      stage.target.epoch !== command.target.epoch ||
      stage.target.ownerToken !== command.target.ownerToken
    ) {
      throw new Error('fork installation does not match its completed stage')
    }
    const head = this.db
      .prepare(
        'SELECT workspace_id,epoch,last_sequence,highest_fence FROM journal_chat_state WHERE session_id=?'
      )
      .get(stage.target.sessionId)
    const child = this.db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
      .get(stage.target.sessionId)
    if (
      head?.epoch !== stage.target.epoch ||
      head.workspace_id !== stage.identity.workspaceId ||
      Number(head.last_sequence) !== stage.priorSequence ||
      (child ? String(child.record_json) : null) !== stage.priorRecord
    ) {
      throw new Error('fork child changed before installation')
    }
    assertJournalFence(stage.fence, Number(head.highest_fence))
    validateJournalForkSource(this.db, stage.source)
    const forkedFrom = {
      sessionId: stage.source.sessionId,
      itemId: stage.source.throughItemId,
      childBoundary:
        stage.lastItemId === null
          ? { kind: 'start' as const }
          : { kind: 'item' as const, itemId: stage.lastItemId }
    }
    let receipt = false
    const effects = command.effects?.map((effect) => {
      if (effect.kind !== 'store') {
        return effect
      }
      const mutation = effect.mutation.input
      if (mutation.kind === 'command' && mutation.command.kind === 'found') {
        const request = mutation.command.request
        if (
          request.sessionId !== stage.target.sessionId ||
          request.operation.operationId !== stage.operationId ||
          request.operation.fingerprint !== stage.fingerprint
        ) {
          throw new Error('fork founding identity changed')
        }
        receipt = true
        return {
          ...effect,
          mutation: {
            ...effect.mutation,
            input: {
              ...mutation,
              command: { ...mutation.command, request: { ...request, forkedFrom } }
            }
          }
        }
      }
      if (mutation.kind === 'fork-boundary' && mutation.sessionId === stage.target.sessionId) {
        receipt = true
        return { ...effect, mutation: { ...effect.mutation, input: { ...mutation, forkedFrom } } }
      }
      return effect
    })
    if (!receipt) {
      throw new Error('fork installation requires its founding or adoption receipt')
    }
    const origin = stage.historyOrigin
      ? {
          providerHandle: agentSessionJournalProviderHandle(stage.identity),
          raw: stage.historyOrigin
        }
      : null
    const sequence = stage.count + 1
    this.db
      .prepare(`UPDATE journal_chat_state SET epoch=?,last_sequence=?,retained_sequence=?,highest_fence=?,context_boundary=0,
      last_activity_at=?,derived_turn_item_id=?,history_origin_json=?,queue_latest_stop_json=NULL,queue_manual_stop_json=NULL,
      queue_resumed_sequence=0,queue_reopened_sequence=0,queue_clear_sequence=NULL,queue_clear_operation_id=NULL,queue_clear_lifted=0,
      queue_failure_boundary=0,accepted_handover_sequence=0,queue_revision=0,submissions_revision=0 WHERE session_id=?`)
      .run(
        stage.epoch,
        sequence,
        sequence,
        stage.fence,
        stage.lastActivity,
        stage.derived,
        origin ? JSON.stringify(origin) : null,
        stage.target.sessionId
      )
    this.live.delete(stage.token)
    return {
      ...command,
      target: { ...command.target, epoch: stage.epoch },
      effects,
      forkInstall: undefined
    }
  }

  private begin(input: JournalForkStageBegin): { token: string } {
    if (this.holds(input.target.sessionId)) {
      throw new Error('fork child already has a private stage')
    }
    const head = this.db
      .prepare(
        'SELECT workspace_id,epoch,last_sequence,highest_fence FROM journal_chat_state WHERE session_id=?'
      )
      .get(input.target.sessionId)
    if (
      !head ||
      head.epoch !== input.target.epoch ||
      head.workspace_id !== input.identity.workspaceId ||
      Number(head.last_sequence) > 1 ||
      this.db
        .prepare('SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? LIMIT 1')
        .get(input.target.sessionId, input.target.epoch)
    ) {
      throw new Error('fork requires the existing empty founding or adoption journal')
    }
    if (input.identity.sessionId !== input.target.sessionId) {
      throw new Error('fork child identity mismatch')
    }
    assertJournalFence(input.fence, Number(head.highest_fence))
    const record = this.db
      .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
      .get(input.target.sessionId)
    const stage: Stage = {
      ...input,
      token: randomUUID(),
      epoch: randomUUID(),
      priorSequence: Number(head.last_sequence),
      priorRecord: record ? String(record.record_json) : null,
      count: 0,
      lastItemId: null,
      derived: null,
      lastActivity: 0
    }
    this.live.set(stage.token, stage)
    return { token: stage.token }
  }
}
