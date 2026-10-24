// Recovery proves delivery only by presence; missing history never proves non-delivery.

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

export type AcpStoredUserMessage = {
  /** Provider ID, claimed at most once. */
  id: string
  blocks: NativeChatBlock[]
  /** Epoch milliseconds on the execution host's clock. */
  createdAt: number
}

export type AcpStoredUserMessagesReader = (input: {
  env: Record<string, string>
  providerSessionId: string
  signal: AbortSignal
}) => Promise<AcpStoredUserMessage[] | null>

// Queued submissions never reached the agent.
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

/** Claim accepted sends' matching copies first to avoid falsely confirming identical sends in doubt. */
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

export async function readAcpRecoveryHistory(
  input: Pick<AcpStructuredSessionAdapterDeps, 'readLaunch' | 'readJournal' | 'logger'> & {
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
    const launch = await waitForPromiseWithSignal(input.readLaunch(identity), signal)
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
      // Neither the read boundary nor completion of the agent's work is known.
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
