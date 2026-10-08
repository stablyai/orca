// The scripted provider behind the queued-message rig: the adapter double the host drives, and
// the events it writes back as the provider would.

import { vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

export type QueuedRigProviderOptions = {
  /** A child started for a chat whose chain already names a thread resumes it, so a chat whose
   *  child closed or died can start another. */
  restartable?: true
  /** Every child stays starting. */
  starting?: true
  /** The provider's Stop ends its child, as Claude's does. */
  stopEndsSession?: true
  /** Its child never answers its start, so it runs nothing it is handed. */
  startUnanswered?: true
}

export function createQueuedRigProvider(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  options: QueuedRigProviderOptions
) {
  // Admitted: the message is written and unanswered, so the session owes work
  // until the test settles it.
  const dispatch: Mock<StructuredAgentSessionAdapter['dispatch']> = vi.fn(async () => ({
    state: 'admitted' as const
  }))
  // Every start the host asks for; one `holdNextStart` holds stays in its spawn until released.
  const starts: Mock<() => void> = vi.fn()
  let startHold: Promise<void> | null = null
  let startFailure: Error | null = null
  // The provider's receipt of a /compact; its end arrives later, as `finishCompact` writes it.
  const compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>> = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: null
  }))
  const cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']> = vi.fn(async () => ({
    cancelled: true
  }))
  const closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>> = vi.fn(
    async () => true
  )
  let events: StructuredAgentSessionEventSink | undefined

  const adapter: StructuredAgentSessionAdapter = {
    acquire: async ({ identity, fence, spawnToken, events: sink }) => {
      starts()
      const hold = startHold
      startHold = null
      await hold
      const failure = startFailure
      startFailure = null
      if (failure) {
        throw failure
      }
      events = sink
      const resumes =
        options.restartable === true &&
        (store.getRecord(identity.sessionId)?.providerHandleChain.length ?? 0) > 0
      return {
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        acquisitionGeneration: 'generation-1',
        ...(options.starting ? { providerChildPhase: 'starting' as const } : {}),
        link: {
          linkId: `link-${fence}`,
          handle: codexProviderHandle(THREAD),
          origin: resumes ? ('resumed' as const) : ('created' as const),
          mintedAtFence: fence,
          observedAt: NOW
        }
      }
    },
    dispatch,
    closeSession,
    releaseAcquisition: vi.fn(async () => true),
    compact,
    cancelTurn,
    ...(options.stopEndsSession ? { stopEndsSession: () => true } : {}),
    ...(options.startUnanswered ? { startAnswered: () => false } : {}),
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => undefined)
  }

  /** What the provider's translator writes when a /compact's turn ends, as a success. */
  function finishCompact(): void {
    const { command } = compact.mock.calls.at(-1)![0]
    events!.appendLifecycleBatch!(
      `turn-completed:${command.clientMessageId}`,
      [
        {
          kind: 'item',
          identity: command.identity,
          body: { ...command.running, state: 'completed', outcome: 'success', completedAt: NOW },
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        }
      ],
      { lifecycle: true }
    )
  }

  /** Holds the next start in its spawn, with what it was asked for still queued, until released. */
  function holdNextStart(): () => void {
    let release = (): void => {}
    startHold = new Promise<void>((resolve) => (release = resolve))
    return () => release()
  }

  /** Fails the next start in its spawn, as an agent that cannot start does. */
  function failNextStart(error: Error): void {
    startFailure = error
  }

  /** The event sink the provider writes through. */
  function providerEvents(): StructuredAgentSessionEventSink {
    if (!events) {
      throw new Error('no provider bound')
    }
    return events
  }

  return {
    adapter,
    dispatch,
    starts,
    holdNextStart,
    failNextStart,
    compact,
    cancelTurn,
    closeSession,
    finishCompact,
    providerEvents
  }
}
