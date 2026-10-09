// The scripted provider behind the queued-message rig: the adapter double the host drives, and
// the events it writes back as the provider would.

import { vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { isStructuredAgentSessionMainAgentWorking } from '../../../shared/structured-agent-session-main-agent-working'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

export type QueuedRigProviderOptions = {
  rewind?: NonNullable<StructuredAgentSessionAdapter['rewind']>
  recoverRewind?: NonNullable<StructuredAgentSessionAdapter['recoverRewind']>
  /** A child started for a chat whose chain already names a thread resumes it, so a chat whose
   *  child closed or died can start another. */
  restartable?: true
  /** Every child stays starting: it never answers its start, so it is handed nothing. */
  starting?: true
  /** A Stop's end of the child waits, as every shipping adapter's does, for the work it stopped
   *  to end (no running turn, no unanswered send), or for the grace to run out. */
  windsDown?: true
}

/** How long a winding-down child is given after the interrupt before the Stop ends it. */
export const QUEUED_RIG_STOP_GRACE_MS = 2_000

export function createQueuedRigProvider(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  options: QueuedRigProviderOptions,
  host: () => StructuredAgentSessionHost
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

  const scripted: StructuredAgentSessionAdapter = {
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
      const record = store.getRecord(identity.sessionId)
      const context = record ? activeProviderContext(record) : null
      const resumes = options.restartable === true && context?.head != null
      const thread = context?.pendingClear
        ? `${THREAD}-context-${record!.providerContextBoundary!.operationId}`
        : (context?.head?.handle.nativeId ?? THREAD)
      return {
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken
        },
        acquisitionGeneration: 'generation-1',
        link: {
          linkId: `link-${fence}`,
          handle: codexProviderHandle(thread),
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
    answerPrompt: vi.fn(async () => undefined),
    setOption: vi.fn(async () => undefined),
    ...(options.rewind
      ? { rewind: options.rewind, rewindSupport: () => ({ supported: true as const }) }
      : {}),
    ...(options.recoverRewind ? { recoverRewind: options.recoverRewind } : {}),
    ...(options.windsDown
      ? {
          awaitStoppedRequestEnd: async (sessionId: string, stoppedAt: number) => {
            while (Date.now() < stoppedAt + QUEUED_RIG_STOP_GRACE_MS && working(sessionId)) {
              await new Promise((resolve) => setTimeout(resolve, 5))
            }
          }
        }
      : {})
  }

  function working(sessionId: string): boolean {
    const journal = host().collaboratorsForTests().sessions.get(sessionId)?.journal
    return (
      journal !== undefined &&
      isStructuredAgentSessionMainAgentWorking(
        journal.activeTurnId(),
        journal.submissions(),
        store.getRecord(sessionId)?.lease.runtimeFence
      )
    )
  }

  const adapter = options.starting ? scripted : startsWhenPublished(scripted, host)

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
