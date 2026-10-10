// What earlier provider runs of a session left of its subagent rows, re-derived from the rows they
// journaled.
//
// The tracker lives in one provider process, but every row it writes outlives that process under a
// restart-stable identity. A run that started from nothing would rewrite a row no turn owns from
// empty and list a resumed child twice, so a run reads what earlier runs left instead: derived,
// never stored, so it cannot disagree with the rows it came from.

import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemIdentity,
  type AgentJournalProducerLinkage,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import {
  isSubagentGroupBlock,
  type NativeChatSubagentEntry
} from '../../../shared/native-chat-types'
import type { StructuredAgentSessionLinkageJournal } from '../agent-session-wire/structured-agent-session-event-sink'
import type { JournaledSubagentSource } from './subagent-tracker-types'

type JournaledGroup = {
  entries: readonly NativeChatSubagentEntry[]
  placement: AgentJournalTurnScope
}

/** More an agent reads from the same pass, from who produced each row. */
export type JournaledSubagentExtension<Extra> = {
  create: () => Extra
  visit: (extra: Extra, linkage: AgentJournalProducerLinkage) => void
}

type Reading<Extra> = {
  rowsByGroup: Map<string, JournaledGroup>
  groupByEntry: Map<string, string>
  extra: Extra | null
}

/** Read once per bound journal epoch. Before the journal is bound nothing is read and nothing is
 *  kept, so the first read after bind still sees every row. */
export class JournaledSubagentGroups<
  Extra = never
> implements JournaledSubagentSource<AgentJournalTurnScope> {
  private journal: StructuredAgentSessionLinkageJournal | null = null
  private epoch: string | null = null
  private reading: Reading<Extra> | null = null

  constructor(
    private readonly bound: () => StructuredAgentSessionLinkageJournal | null,
    private readonly identityFor: (groupId: string) => AgentJournalItemIdentity,
    private readonly extension?: JournaledSubagentExtension<Extra>
  ) {}

  groupOf = (id: string): string | null => this.current()?.groupByEntry.get(id) ?? null

  claimGroup = (groupId: string): JournaledGroup | null => {
    const reading = this.current()
    const row = reading?.rowsByGroup.get(groupId) ?? null
    reading?.rowsByGroup.delete(groupId)
    return row
  }

  /** The extension's reading of the bound journal; null before bind. */
  extra(): Extra | null {
    return this.current()?.extra ?? null
  }

  private current(): Reading<Extra> | null {
    const journal = this.bound()
    if (!journal) {
      return null
    }
    if (!this.reading || journal !== this.journal || journal.epoch !== this.epoch) {
      this.journal = journal
      this.epoch = journal.epoch
      this.reading = this.read(journal)
    }
    return this.reading
  }

  private read(journal: StructuredAgentSessionLinkageJournal): Reading<Extra> {
    const reading: Reading<Extra> = {
      rowsByGroup: new Map(),
      groupByEntry: new Map(),
      extra: this.extension?.create() ?? null
    }
    // A child two rows list (only an older build wrote that) is the later-created row's: a turn's
    // row is created with its turn, so that is where it last ran.
    const listedAt = new Map<string, number>()
    journal.visitItemsWithLinkage((itemId, sequence, body, attribution) => {
      if (this.extension && reading.extra !== null) {
        this.extension.visit(reading.extra, attribution)
      }
      const group = body.kind === 'message' ? body.blocks.find(isSubagentGroupBlock) : undefined
      if (!group || itemId !== agentJournalItemKey(this.identityFor(group.groupId))) {
        return
      }
      reading.rowsByGroup.set(group.groupId, {
        entries: group.agents,
        placement: attribution.turnScope ?? AGENT_JOURNAL_THREAD_SCOPE
      })
      for (const entry of group.agents) {
        if ((listedAt.get(entry.id) ?? -1) < sequence) {
          listedAt.set(entry.id, sequence)
          reading.groupByEntry.set(entry.id, group.groupId)
        }
      }
    })
    return reading
  }
}
