import { vi, type Mock } from 'vitest'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { startsWhenPublished } from './structured-agent-session-instant-start.test-support'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_THREAD as THREAD
} from './structured-agent-session-host-test-data'

export type QueuedRigProviderOptions = {
  rewind?: NonNullable<StructuredAgentSessionAdapter['rewind']>
  recoverRewind?: NonNullable<StructuredAgentSessionAdapter['recoverRewind']>
  /** Resume the saved thread on later children after close/death. */
  restartable?: true
  starting?: true
  /** Stop ends the child, as with Claude. */
  stopEndsSession?: true
  /** Startup never answers; queued input cannot run. */
  startUnanswered?: true
  reportsModel?: string
  reportsEffort?: string
}

export function createQueuedRigProvider(
  store: Pick<AgentSessionRecordStore, 'getRecord'>,
  options: QueuedRigProviderOptions,
  host: () => StructuredAgentSessionHost
) {
  // Admitted sends owe work until explicitly settled.
  const dispatch: Mock<StructuredAgentSessionAdapter['dispatch']> = vi.fn(async () => ({
    state: 'admitted' as const
  }))
  const starts: Mock<() => void> = vi.fn()
  let startHold: Promise<void> | null = null
  let startFailure: Error | null = null
  // Acceptance precedes the later finishCompact turn-end event.
  const compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>> = vi.fn(async () => ({
    state: 'accepted' as const,
    providerIdentity: null
  }))
  const cancelTurn: Mock<StructuredAgentSessionAdapter['cancelTurn']> = vi.fn(async () => ({
    cancelled: true
  }))
  const setOption: Mock<StructuredAgentSessionAdapter['setOption']> = vi.fn(async () => undefined)
  const closeSession: Mock<NonNullable<StructuredAgentSessionAdapter['closeSession']>> = vi.fn(
    async () => true
  )
  let events: StructuredAgentSessionEventSink | undefined
  let proveOpen: (() => void) | null = null

  const reported = () => ({
    model: options.reportsModel ?? 'default',
    ...(options.reportsEffort ? { effort: options.reportsEffort } : {})
  })
  const scripted: StructuredAgentSessionAdapter = {
    open: () =>
      options.starting
        ? new Promise((resolve) => {
            proveOpen = () => resolve({ reportedOptions: reported() })
          })
        : Promise.resolve({ reportedOptions: reported() }),
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
        ...(options.starting ? { providerChildPhase: 'starting' as const } : {}),
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
    ...(options.stopEndsSession ? { stopEndsSession: () => true } : {}),
    ...(options.startUnanswered ? { startAnswered: () => false } : {}),
    answerPrompt: vi.fn(async ({ commit }) => commit()),
    setOption,
    ...(options.rewind
      ? { rewind: options.rewind, rewindSupport: () => ({ supported: true as const }) }
      : {}),
    ...(options.recoverRewind ? { recoverRewind: options.recoverRewind } : {})
  }

  const adapter = options.starting ? scripted : startsWhenPublished(scripted, host)

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

  function holdNextStart(): () => void {
    let release = (): void => {}
    startHold = new Promise<void>((resolve) => (release = resolve))
    return () => release()
  }

  function failNextStart(error: Error): void {
    startFailure = error
  }

  function providerEvents(): StructuredAgentSessionEventSink {
    if (!events) {
      throw new Error('no provider bound')
    }
    return events
  }

  return {
    adapter,
    proveOpen: () => proveOpen?.(),
    dispatch,
    starts,
    holdNextStart,
    failNextStart,
    compact,
    cancelTurn,
    setOption,
    closeSession,
    finishCompact,
    providerEvents
  }
}
