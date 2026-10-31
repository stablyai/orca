import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { structuredAgentSessionCommandTurn } from './structured-agent-session-command-turn'
import {
  attach,
  CALLER,
  envelope,
  hostTestState,
  serveHostTestChildWork
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_NOW, HOST_TEST_SESSION } from './structured-agent-session-host-test-data'
import { reportedChildWork } from './structured-agent-session-reported-child-work.test-support'

let state: ReturnType<typeof hostTestState>
let compact: Mock<NonNullable<StructuredAgentSessionAdapter['compact']>>
let records: AgentChildWorkView[] = []

function report(next: AgentChildWorkView[]): void {
  records = next
  state.host.publishChildWorkEvidence(HOST_TEST_SESSION, reportedChildWork(next, HOST_TEST_NOW))
}

function compactParams() {
  return {
    command: 'compact' as const,
    envelope: envelope('agentSession.conversationCommand', { command: 'compact' })
  }
}

function devServer(overrides: Partial<AgentChildWorkView> = {}): AgentChildWorkView {
  return {
    id: 'child-dev',
    providerId: 'task-dev',
    kind: 'command',
    description: 'npm run dev',
    state: 'working',
    membership: 'live',
    firstObservedAt: HOST_TEST_NOW,
    observedAt: HOST_TEST_NOW,
    stoppable: true,
    invocation: { invocationId: 'spawn-dev', generation: 1 },
    ...overrides
  }
}

function finish(): void {
  const { command } = compact.mock.calls.at(-1)![0]
  const events = state.acquire.mock.calls.at(-1)![0].events!
  events.appendLifecycleBatch!(
    `turn-completed:${command.clientMessageId}`,
    [
      {
        kind: 'item',
        identity: command.identity,
        body: { ...command.running, state: 'completed', outcome: 'success' },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ],
    { lifecycle: true }
  )
}

async function commandTurnState(clientMessageId: string): Promise<string | undefined> {
  const { itemId } = structuredAgentSessionCommandTurn(clientMessageId)
  const item = (await state.host.journalSnapshot(HOST_TEST_SESSION)).items.find(
    (entry) => entry.itemId === itemId
  )
  return item?.body.kind === 'turn' ? item.body.state : undefined
}

beforeEach(() => {
  records = []
  state = hostTestState()
  compact = vi.fn(async () => ({ state: 'accepted' as const, providerIdentity: null }))
  const trackerRoster: AgentSessionBackgroundTaskState = {
    state: 'monitoring',
    tasks: [{ id: 'tracker-only', kind: 'command', description: 'not on the strip' }]
  }
  Object.assign(state.host.deps.adapter, {
    compact,
    backgroundTaskStops: () => ({ supportsTaskStop: true, supportsStopAll: true }),
    // Keep a drifted provider roster claiming live work after visible records settle.
    backgroundTaskState: () => trackerRoster
  })
  serveHostTestChildWork(() => records)
})

describe('conversation command admission reads the work the provider reported', () => {
  it('refuses only while reported work runs, and names the stop the strip offers', async () => {
    await attach()
    const strip: (AgentSessionBackgroundTaskState | null)[] = []
    await state.host.subscribe({
      id: 'strip',
      sessionId: HOST_TEST_SESSION,
      emit: (event) => {
        if ('backgroundTasks' in event && event.backgroundTasks !== undefined) {
          strip.push(event.backgroundTasks)
        }
      }
    })
    const stripRows = () =>
      (strip.at(-1)?.children ?? []).map((row) => ({
        description: row.description,
        membership: row.membership,
        stoppable: row.stoppable,
        providerId: row.providerId
      }))

    expect(stripRows()).toEqual([])
    const first = compactParams()
    expect(await state.host.conversationCommand(CALLER, first)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
    finish()
    await vi.waitFor(async () =>
      expect(await commandTurnState(first.envelope.clientOperationId)).toBe('completed')
    )

    report([devServer()])
    expect(stripRows()).toEqual([
      { description: 'npm run dev', membership: 'live', stoppable: true, providerId: 'task-dev' }
    ])
    expect(await state.host.conversationCommand(CALLER, compactParams())).toMatchObject({
      ok: false,
      refusal: { message: 'Stop background tasks before using this command.' }
    })

    report([devServer({ state: 'done', membership: 'settled', outcome: 'succeeded' })])
    expect(strip.at(-1)).toBeNull()
    expect(stripRows()).toEqual([])
    expect(await state.host.conversationCommand(CALLER, compactParams())).toMatchObject({
      ok: true
    })
    await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2))
  })

  it('refuses a queued command at handover once reported work runs', async () => {
    const acquireChild = state.acquire.getMockImplementation()!
    state.acquire.mockImplementation(async (input) => ({
      ...(await acquireChild(input)),
      acquisitionGeneration: `generation-${input.fence}`
    }))
    await attach()
    const fence = state.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence
    await state.host.handleAdapterEvent({
      type: 'ended',
      sessionId: HOST_TEST_SESSION,
      fence,
      acquisitionGeneration: `generation-${fence}`,
      reason: 'provider exited',
      cause: 'unexpected-exit'
    })
    await vi.waitFor(() => expect(state.host['sessions'].get(HOST_TEST_SESSION)?.child).toBeNull())
    const start = state.acquire.getMockImplementation()!
    state.acquire.mockImplementationOnce(async (input) => {
      report([devServer()])
      return start(input)
    })
    const params = compactParams()
    expect(await state.host.conversationCommand(CALLER, params)).toMatchObject({ ok: true })

    await vi.waitFor(async () => {
      const submission = (await state.host.journalSnapshot(HOST_TEST_SESSION)).submissions.find(
        (entry) => entry.clientMessageId === params.envelope.clientOperationId
      )
      expect(submission?.dispatchState).toBe('rejected')
    })
    expect(state.acquire).toHaveBeenCalledTimes(2)
    expect(compact).not.toHaveBeenCalled()
  })
})
