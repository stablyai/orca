import type { AgentSessionStoreRowWrites } from '../../runtime/agent-session/records/agent-session-store-draft'
import type { PreparedAgentSessionAttachmentClaim } from '../agent-session-attachments/agent-session-attachment-claims'
import type { CommandReceipt, CommandReceiptScope } from './command-receipt-schema'
import type { JournalOutcome } from './journal-outcome-codec'
import type { JournalReadConnection } from './journal-sql-owner'
import type { CommandReceiptRead } from './command-receipt-table'
import type { JournalReducerState } from './journal-reducer'
import { finishJournalStepsAsync } from './journal-reconstruction-steps'
import { settleJournalCommitAsync } from './journal-row-writer'

export type JournalEncodedOutcome = Omit<JournalOutcome, 'ordinal'> & {
  reinsert: boolean
  changed: boolean
  index: number
}

export type JournalPersistenceEffect =
  | {
      kind: 'rows'
      sessionId: string
      rows: { epoch: string; seq: number; savedAt: number; json: string }[]
    }
  | { kind: 'queue-delete'; sessionId: string; ids: string[] }
  | { kind: 'store'; writes: AgentSessionStoreRowWrites; insertOperationsIfAbsent: boolean }
  | { kind: 'receipt'; scope: CommandReceiptScope; receipt: CommandReceipt }
  | { kind: 'claim'; claim: PreparedAgentSessionAttachmentClaim }
  | {
      kind: 'sweep'
      operation:
        | { kind: 'mark'; uploadId: string; now: number }
        | { kind: 'finish'; uploadId: string }
        | { kind: 'prune'; pairs: { uploadId: string; sessionId: string }[] }
    }
  | {
      kind: 'epoch'
      sessionId: string
      workspaceId: string
      epoch: string
      expected?: string | null
    }
  | {
      kind: 'outcomes'
      sessionId: string
      epoch: string
      expected: number
      savedAt: number
      values: JournalEncodedOutcome[]
      through: number
    }

export type JournalEffectResult =
  | { referenced: Set<string>; inserted: string[] }
  | boolean
  | number
  | null

/** Prepared under host mutation ownership, before any native transaction starts. */
export class JournalPersistencePlan {
  readonly effects: JournalPersistenceEffect[] = []
  preparedState: JournalReducerState | undefined
  releaseReplacement: (() => void) | undefined
  private readonly results: ((result: JournalEffectResult) => void)[] = []

  constructor(readonly read: JournalReadConnection) {}

  add(
    effect: JournalPersistenceEffect,
    result: (value: JournalEffectResult) => void = () => {}
  ): void {
    this.effects.push(effect)
    this.results.push(result)
  }

  async source(sessionId: string, epoch: string) {
    const effects = this.effects
    const created = await finishJournalStepsAsync(
      (function* () {
        for (const effect of effects) {
          if (effect.kind === 'epoch' && effect.sessionId === sessionId && effect.epoch === epoch) {
            return true
          }
          yield
        }
        return false
      })()
    )
    if (created) {
      return null
    }
    return this.read.source(sessionId, epoch)
  }

  /** Only receipt effects preceding this preparation phase are visible. */
  async receipts(
    scope: CommandReceiptScope,
    ids: readonly string[]
  ): Promise<Map<string, CommandReceiptRead>> {
    const values = await this.read.receipts(scope, ids)
    let work = 0
    for (const effect of this.effects) {
      if (++work === 128) {
        work = 0
        await new Promise<void>((resolve) => setImmediate(resolve))
      }
      if (effect.kind !== 'receipt' || !values.has(effect.receipt.operationId)) {
        continue
      }
      if (scope.kind === 'caller' && effect.receipt.callerKey !== scope.callerKey) {
        continue
      }
      if (values.get(effect.receipt.operationId)?.verdict === 'absent') {
        values.set(effect.receipt.operationId, { verdict: 'readable', receipt: effect.receipt })
      }
    }
    return values
  }

  settle(values: JournalEffectResult[]): Promise<void> {
    const results = this.results
    return settleJournalCommitAsync(
      (function* () {
        for (let index = 0; index < results.length; index++) {
          yield () => results[index](values[index] ?? null)
        }
      })()
    )
  }
}
