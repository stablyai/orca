import type { ConnectorFailure } from '../../shared/connectors/connector-cloud-contract'
import type {
  JournalConnectorReplyCut,
  JournalConnectorReplyCutRows,
  JournalConnectorReplyFill,
  JournalConnectorReplyKey,
  JournalConnectorReplyRetryRows,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'

export type ConnectorReplyJournal = {
  read(sessionId?: string): Promise<JournalConnectorReplyRow[]>
  /** One page of an account's filled, unsent rows after a delivery id, in delivery id order. */
  readOwed(
    account: string,
    after: string | null,
    limit: number,
    includePresentations?: boolean
  ): Promise<JournalConnectorReplyRow[]>
  fillOutcomes(fills: readonly JournalConnectorReplyFill[]): Promise<boolean>
  sent(keys: readonly JournalConnectorReplyKey[]): Promise<void>
}

/** The rows' cut and claim writes (Phase 1): what restart and usage-limit recovery change. */
export type ConnectorReplyCutJournal = ConnectorReplyJournal & {
  cut(rows: JournalConnectorReplyCutRows): Promise<boolean>
  recut(
    claimMessageId: string,
    cut: JournalConnectorReplyCut,
    failure?: ConnectorFailure
  ): Promise<boolean>
  releaseClaim(claimMessageId: string): Promise<boolean>
  holdForRetry(rows: JournalConnectorReplyRetryRows): Promise<boolean>
}
