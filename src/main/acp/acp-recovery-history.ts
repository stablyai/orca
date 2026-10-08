// Restart recovery for an ACP agent that keeps its own store: whether a message a crash left
// unconfirmed reached the agent. Presence only: a match settles it as sent, while absence proves
// nothing, so nothing is ever called undelivered. Bounded, and null on any failure; the user can
// always resend or discard, so this never stands between them and the chat.

import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { agentSessionSendBodyFingerprint } from '../../shared/structured-agent-session-send-mutation'
import type {
  AgentJournalSubmission,
  AgentSessionJournalIdentity
} from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import type { JournalLoad } from '../native-chat/agent-session-journal/journal-open'
import type {
  ProviderHistoryItem,
  ProviderHistoryWindow
} from '../native-chat/agent-session-journal/journal-submission-reconciler'
import { isQueuedAgentJournalSubmission } from '../../shared/agent-session-queued-submission'
import type { AcpLaunchSpec } from './acp-launch-specs'
import type { AcpStructuredSessionAdapterDeps } from './acp-structured-session-adapter-deps'

const RECOVERY_READ_MS = 5_000

/** A person's message as the agent's own store holds it. */
export type AcpStoredUserMessage = {
  /** The store's id for it, claimed at most once. */
  id: string
  blocks: NativeChatBlock[]
  /** Epoch ms the agent recorded it, on this machine's clock. */
  createdAt: number
}

/** Reads the user messages of one provider session from the agent's own store; null when it cannot. */
export type AcpStoredUserMessagesReader = (input: {
  env: Record<string, string>
  providerSessionId: string
  signal: AbortSignal
}) => Promise<AcpStoredUserMessage[] | null>

/** Sends a crash may have left unconfirmed; a queued card was never handed over, so the agent
 *  cannot hold it. */
function sendsInDoubt(load: JournalLoad): AgentJournalSubmission[] {
  return [...load.state.submissions.values()].filter(
    (submission) =>
      (submission.dispatchState === 'pending' || submission.dispatchState === 'unknown') &&
      !isQueuedAgentJournalSubmission(submission)
  )
}

function fingerprintOf(sessionId: string, message: AcpStoredUserMessage): string {
  return agentSessionSendBodyFingerprint(sessionId, {
    kind: 'message',
    role: 'user',
    blocks: message.blocks
  })
}

/**
 * The agent's store keeps no id of Orca's, so a stored message can only match a send by content.
 * Each send the journal already accepted first claims the earliest stored copy of its text written
 * no earlier than it was sent, so an identical message that did reach the agent is never offered as
 * the one in doubt; what is left, from the first send in doubt on, is the window. Claiming more than
 * a send's own copy only leaves a send in doubt unconfirmed, never wrongly confirmed.
 */
function recoveryWindow(
  load: JournalLoad,
  inDoubt: readonly AgentJournalSubmission[],
  messages: readonly AcpStoredUserMessage[]
): ProviderHistoryItem[] {
  const submissions = [...load.state.submissions.values()]
  const from = Math.min(...inDoubt.map((submission) => submission.submittedAt))
  const stored = messages
    .map((message) => ({ message, fingerprint: fingerprintOf(load.state.sessionId, message) }))
    .toSorted((left, right) => left.message.createdAt - right.message.createdAt)
  const claimed = new Set<number>()
  const accepted = submissions
    .filter((submission) => submission.dispatchState === 'accepted')
    .toSorted((left, right) => left.submittedAt - right.submittedAt)
  for (const submission of accepted) {
    const index = stored.findIndex(
      ({ message, fingerprint }, at) =>
        !claimed.has(at) &&
        fingerprint === submission.payloadFingerprint &&
        message.createdAt >= submission.submittedAt
    )
    if (index !== -1) {
      claimed.add(index)
    }
  }
  return stored.flatMap(({ message, fingerprint }, at) =>
    claimed.has(at) || message.createdAt < from
      ? []
      : [{ providerItemId: message.id, clientMessageId: null, payloadFingerprint: fingerprint }]
  )
}

/** The window for one chat; null for an agent whose store Orca does not read. */
export async function readAcpRecoveryHistory(
  input: Pick<AcpStructuredSessionAdapterDeps, 'resolveLaunch' | 'readJournal' | 'logger'> & {
    spec: Pick<AcpLaunchSpec, 'readStoredUserMessages'>
  },
  identity: AgentSessionJournalIdentity
): Promise<ProviderHistoryWindow | null> {
  const { readStoredUserMessages } = input.spec
  if (!readStoredUserMessages || !input.readJournal) {
    return null
  }
  const sessionId = identity.sessionId
  const signal = AbortSignal.timeout(RECOVERY_READ_MS)
  try {
    const load = input.readJournal(sessionId)
    const inDoubt = load && !load.damage && !load.newer ? sendsInDoubt(load) : []
    if (!load || inDoubt.length === 0) {
      return null
    }
    const launch = await waitForPromiseWithSignal(input.resolveLaunch({ identity }), signal)
    if (!launch.resume) {
      return null
    }
    const messages = await waitForPromiseWithSignal(
      readStoredUserMessages({
        env: launch.env,
        providerSessionId: launch.resume.sessionId,
        signal
      }),
      signal
    )
    if (!messages) {
      return null
    }
    return {
      // Absence proves nothing: neither the start of the read nor the end of the agent's work is known.
      boundaryConsistent: false,
      turnInFlight: true,
      items: recoveryWindow(load, inDoubt, messages)
    }
  } catch (error) {
    input.logger?.warn('ACP recovery history could not be read', {
      scope: 'acp-recovery-history',
      sessionId,
      error
    })
    return null
  }
}
