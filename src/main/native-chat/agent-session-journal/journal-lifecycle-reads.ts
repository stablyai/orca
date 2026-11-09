import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'

/** The live epoch with the sends accepted after an offer's cursor, read together. */
export type JournalRestartProgress = {
  epoch: string
  acceptedInputs: readonly AgentJournalSubmission[]
}

export type JournalOutgrownChildRead = { fence: number; nextClientMessageId?: string }

export type JournalOutgrownChild = {
  signedOut: boolean
  newestTurnCompletedAt: number | undefined
  nextMessage: AgentJournalMessageItem | null
}
