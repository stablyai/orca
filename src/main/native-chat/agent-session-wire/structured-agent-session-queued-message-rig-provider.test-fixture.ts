import { vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { activeProviderContext } from '../../../shared/agent-session-provider-context'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../shared/agent-session-provider-handle-encoding'
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
  agent?: 'claude'
  rewind?: NonNullable<StructuredAgentSessionAdapter['rewind']>
  recoverRewind?: NonNullable<StructuredAgentSessionAdapter['recoverRewind']>
  /** Resume the saved thread on later children after close/death. */
  restartable?: true
  /** Startup never answers; queued input cannot run. */
  starting?: true
  /** Wait for stopped work to end or grace expiry before closing the child. */
  windsDown?: true
  /** The model its child reports running; otherwise the agent's own `default`. */
  reportsModel?: string
  reportsEffort?: string
}

/** How long a winding-down child is given after the interrupt before the Stop ends it. */
export const QUEUED_RIG_STOP_GRACE_MS = 2_000

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
        link: {
          linkId: `link-${fence}`,
          handle:
            options.agent === 'claude'
              ? claudeProviderHandle(thread, null)
              : codexProviderHandle(thread),
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
    answerPrompt: vi.fn(async ({ commit }) => commit()),
    setOption,
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
    return host().currentWork(sessionId)?.working() ?? false
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
