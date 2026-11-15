import {
  StructuredAgentSessionWorkPolicy,
  structuredAgentSessionLiveFence,
  structuredAgentSessionOwnerUnverifiable
} from '../agent-session-wire/observations/structured-agent-session-work-policy'
import { journalWroteBeforeOpen } from './replay/journal-cursor'
import type { JournalSqlStatusContext } from './journal-sql-status-context'
import type { JournalCurrentWorkAuthority } from './journal-observer-read'

export function readJournalSqlCurrentWork(
  context: JournalSqlStatusContext,
  authority: JournalCurrentWorkAuthority
) {
  const handingOver = new Set(authority.handingOver)
  const continuing = new Set(authority.continuingUnadmitted)
  const finalizing = new Set(authority.finalizing)
  const held =
    authority.child?.heldSends === undefined ? undefined : new Set(authority.child.heldSends)
  const evidence = {
    record: authority.record,
    ended: authority.ended,
    replaced: authority.replaced,
    child:
      authority.child === null
        ? null
        : authority.child === undefined
          ? undefined
          : { fence: authority.child.fence }
  }
  return new StructuredAgentSessionWorkPolicy(
    {
      item: context.displayed,
      itemFence: context.itemFence,
      runningTurn: context.runningTurn,
      recoverableSubmissions: context.recoverableSubmissions,
      wroteBeforeOpen: (sequence) =>
        journalWroteBeforeOpen({ epoch: context.scope.epoch }, authority.openedThrough, sequence),
      continuingInput: (id) =>
        continuing.has(id) && context.submission(id)?.dispatchState === 'pending',
      finalizingInput: (id) => finalizing.has(id),
      handingOver: (id) => handingOver.has(id)
    },
    structuredAgentSessionLiveFence(evidence),
    authority.operationalRevision,
    authority.ended,
    authority.replaced,
    structuredAgentSessionOwnerUnverifiable(evidence),
    () => held
  )
}
