/** More running children than a reopen numbers; past it the read refuses rather than drops one. */
export const JOURNAL_RUNNING_SUBAGENTS_MAX = 64

export type JournalRunningSubagent = { agentId: string; parentAgentId?: string }
