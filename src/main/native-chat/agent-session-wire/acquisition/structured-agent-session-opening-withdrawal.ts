// A background caller's last word on a new chat's opening message. The message is durable once
// its append lands, but nothing delivers it before the chat is registered with the host; the
// caller's `beforeDelivery` is asked synchronously there, after the last await, with nothing
// awaited between a yes and the registration. A no withdraws the message so it never reaches the
// agent; it is withheld in this process first, so even a withdrawal that can't be saved never
// delivers it here, and an earlier process's sends are never handed over after a restart.
import { agentSessionFailureFact } from '../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'
import type { StructuredAgentSessionCreateOptions } from './structured-agent-session-create-options'

const withheld = new Set<string>()

/** An opening message its caller refused at delivery; delivery never selects it. */
export function isWithheldOpeningMessage(clientMessageId: string): boolean {
  return withheld.has(clientMessageId)
}

/** The opening message to withdraw, synchronously; undefined when it is kept. A caller whose
 *  check throws has refused. */
export function refusedOpeningMessage(
  options: Pick<StructuredAgentSessionCreateOptions, 'firstMessage' | 'beforeDelivery'>
): string | undefined {
  const first = options.firstMessage
  if (!first || !options.beforeDelivery) {
    return undefined
  }
  let kept = false
  try {
    kept = options.beforeDelivery()
  } catch {
    kept = false
  }
  if (kept) {
    return undefined
  }
  withheld.add(first.clientMessageId)
  return first.clientMessageId
}

export async function withdrawOpeningMessage(
  journal: Pick<AgentSessionJournal, 'resolveDispatch' | 'reads'>,
  clientMessageId: string,
  fence: number,
  /** Called before rethrowing when the withdrawal could not be saved. */
  failed: () => void
): Promise<void> {
  try {
    if ((await journal.reads.submission(clientMessageId))?.dispatchState !== 'pending') {
      return
    }
    await journal.resolveDispatch({
      clientMessageId,
      state: 'rejected',
      ...agentSessionFailureWords(agentSessionFailureFact('cancelled'), { surface: 'rejection' }),
      fence,
      recovered: true
    })
  } catch (error) {
    failed()
    throw error
  }
}

/** Registers the new chat once its opening message is settled: at once, with nothing awaited, when
 *  it is kept; after its withdrawal when it is refused. */
export function settleOpeningThenRegister(
  journal: Pick<AgentSessionJournal, 'resolveDispatch' | 'reads'>,
  options: Pick<StructuredAgentSessionCreateOptions, 'firstMessage' | 'beforeDelivery'>,
  fence: number,
  failed: () => void,
  register: () => void
): Promise<void> | undefined {
  const refused = refusedOpeningMessage(options)
  if (refused === undefined) {
    register()
    return undefined
  }
  return withdrawOpeningMessage(journal, refused, fence, failed).then(register)
}
