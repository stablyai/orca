import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalStoreCollaborators } from '../store-lifecycle/journal-store-collaborators'
import { journalInputOrder } from '../input-order/journal-input-order'
import { readJournalInputItem } from '../input-order/journal-input-obligations'
import { journalItemExecutionFence } from '../projection/journal-item-provenance'
import { journalContextCursor } from '../context-epochs/journal-context-cursor'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'

/** This view and its lazy SQL values belong to one writer command. */
export function journalGenerationSettlementRead(
  state: () => JournalReducerState,
  collaborators: Pick<
    JournalStoreCollaborators,
    'queuedMessages' | 'stopMarks' | 'lifecycleBatchAppender'
  >,
  items: () => AgentJournalRenderItem[]
) {
  let loaded: AgentJournalRenderItem[] | undefined
  const statusRead = () => ({ items: (loaded ??= items()), submissions: [] })
  return {
    statusRead,
    snapshot: () => ({
      ...statusRead(),
      sessionId: state().sessionId,
      cursor: journalContextCursor(state())
    }),
    get inputOrder() {
      return journalInputOrder(state())
    },
    itemFence: (id: string) => journalItemExecutionFence(state(), id),
    itemBody: (id: string) => readJournalInputItem(state(), id)?.body ?? null,
    submission: (id: string) => state().submissions.get(id),
    submissions: () => journalInputOrder(state()).recoverableSubmissions(),
    stopMarks: collaborators.stopMarks,
    lastProviderActivityAt: (fence: number) => state().providerActivityAt.get(fence),
    cursor: () => journalContextCursor(state()),
    appendPlannedLifecycleBatch: (
      input: Parameters<JournalStoreCollaborators['lifecycleBatchAppender']['appendPlanned']>[0]
    ) => collaborators.lifecycleBatchAppender.appendPlanned(input)
  }
}
