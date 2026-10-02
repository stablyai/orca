// What the host's chats are doing on the main thread, for work that must give way to them (the
// background copy of old chat files): a send its agent has not answered (handed over, or waiting
// while the send starts the agent), and every provider frame that reaches the main thread. Frames are the signal because streamed text and
// tool output are checkpointed into the journal, not written per delta, so a long answer can go
// many seconds between rows while the main thread parses every delta. A turn that is running but
// silent (a long tool call, a prompt waiting on the user) sends no frames and holds nothing.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { isUnansweredStructuredAgentSessionDispatch } from '../../../shared/structured-agent-session-unanswered-dispatch'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionProviderChildPhase } from './structured-agent-session-adapter'

export type StructuredAgentSessionChatWork = {
  /** An open chat has a send its agent has not answered: handed over, or waiting for the agent to
   *  start. One waiting behind a running agent's turn or prompt is not in flight. */
  sendInFlight: () => boolean
  /** Calls `listener` on every provider frame of any chat; returns the unsubscribe. */
  onActivity: (listener: () => void) => () => void
}

type ChatJournal = Pick<AgentSessionJournal, 'isReadOnly' | 'cursor' | 'submissions'>

/** A chat's answer to "a send in flight?", for the journal tip, fence and agent it was read at. */
type InFlightRead = {
  epoch: string
  sequence: number
  fence: number | undefined
  agentReady: boolean
  inFlight: boolean
}

export class StructuredAgentSessionChatActivity implements StructuredAgentSessionChatWork {
  private readonly listeners = new Set<() => void>()
  /** Re-read when any of its inputs moves: every send and answer is a journal row, so a new one
   *  moves the tip. Keyed by the journal, so a closed chat's read goes with it. */
  private readonly reads = new WeakMap<ChatJournal, InFlightRead>()

  constructor(
    private readonly deps: {
      sessions: ReadonlyMap<
        string,
        {
          journal: ChatJournal
          child: { phase: StructuredAgentSessionProviderChildPhase } | null
        }
      >
      /** The conversation's fence: a send from an ended child is no longer in flight. */
      fence: (sessionId: string) => number | undefined
    }
  ) {}

  sendInFlight = (): boolean => {
    for (const [sessionId, { journal, child }] of this.deps.sessions) {
      if (!journal.isReadOnly && this.chatSendInFlight(sessionId, journal, child)) {
        return true
      }
    }
    return false
  }

  private chatSendInFlight(
    sessionId: string,
    journal: ChatJournal,
    child: { phase: StructuredAgentSessionProviderChildPhase } | null
  ): boolean {
    const { epoch, sequence } = journal.cursor()
    const fence = this.deps.fence(sessionId)
    // A ready agent is handed a send at once unless a turn or prompt holds it back.
    const agentReady = child?.phase === 'ready'
    const read = this.reads.get(journal)
    if (
      read?.epoch === epoch &&
      read.sequence === sequence &&
      read.fence === fence &&
      read.agentReady === agentReady
    ) {
      return read.inFlight
    }
    const inFlight = journal
      .submissions()
      .some(
        (submission) =>
          isUnansweredStructuredAgentSessionDispatch(submission, fence) &&
          !(agentReady && isQueuedAgentJournalSubmission(submission))
      )
    this.reads.set(journal, { epoch, sequence, fence, agentReady, inFlight })
    return inFlight
  }

  onActivity = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** A provider frame for an open chat reached the main thread. */
  noteFrame = (): void => {
    for (const listener of this.listeners) {
      listener()
    }
  }
}
