/** Running children a reopen names, most recently active first; the rest are logged. */
export const JOURNAL_RUNNING_SUBAGENTS_MAX = 64

export type JournalRunningSubagent = { agentId: string; parentAgentId?: string }

export type JournalRunningSubagents = { subagents: JournalRunningSubagent[]; more: boolean }
