import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentChildWorkEvidence } from '../../../shared/agent-status-child-work-evidence'
import type { AgentSessionExecutionLocation } from '../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../shared/agent-session-wire'
import { AgentHookServer } from '../../agent-hooks/server'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { performCancel, type AgentSessionTurnContext } from './structured-agent-session-turns'
import { runTargetedCancel } from './structured-agent-session-targeted-cancel'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
import { testEventSinkLogging } from './structured-agent-session-logger-test-support'
import { codexProviderHandle } from '../../../shared/agent-session-provider-handle-encoding'
import { NO_STRUCTURED_AGENTS } from './structured-agent-session-adapter-router-test-support'
import { StructuredAgentSessionStatusOwnership } from './structured-agent-session-status-ownership'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'workspace-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread-1')
}

let root: string | null = null
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  if (root) {
    await rm(root, { recursive: true, force: true })
    root = null
  }
})

describe('performCancel', () => {
  it('acknowledges only the request and leaves the running lifecycle row intact', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const lifecycleIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await journal.appendItem(
      lifecycleIdentity,
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-1',
      turnId: 'turn-1'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: true } })
    expect(cancelTurn).toHaveBeenCalledOnce()
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { kind: 'status', text: 'Cancellation requested.' }
    ])
  })

  it('hands the adapter a live-turn read of the published journal', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-live-turn-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const lifecycleIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    await journal.appendItem(
      lifecycleIdentity,
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    let resolveLiveTurnId: (() => string | null) | undefined
    const cancelTurn = vi.fn(
      async (input: Parameters<StructuredAgentSessionAdapter['cancelTurn']>[0]) => {
        resolveLiveTurnId = input.resolveLiveTurnId
        return { cancelled: true }
      }
    )
    const ctx: AgentSessionTurnContext = {
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      adapter: { cancelTurn } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }

    await performCancel(ctx, { clientOperationId: 'cancel-live-1', turnId: 'turn-1' })

    expect(resolveLiveTurnId?.()).toBe('turn-1')
    // The guard must reread after the turn ends rather than use captured state.
    await journal.appendItem(
      lifecycleIdentity,
      {
        kind: 'status',
        text: 'Done.',
        turnLifecycle: { turnId: 'turn-1', state: 'completed' }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    expect(resolveLiveTurnId?.()).toBeNull()
  })

  it('keeps the running lifecycle when cancellation cannot be confirmed', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-unconfirmed-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    await journal.appendItem(
      {
        provider: 'legacy',
        agent: 'codex',
        sessionId: 'session-1',
        recordId: 'turn-lifecycle:turn-1'
      },
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const ctx: AgentSessionTurnContext = {
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      adapter: {
        cancelTurn: vi.fn(async () => ({ cancelled: false }))
      } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }

    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-unconfirmed-1',
      turnId: 'turn-1'
    })

    expect(result).toEqual({ ok: true, value: { turnId: 'turn-1', cancelled: false } })
    expect(journal.snapshot().items.map((item) => item.body)).toEqual([
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      }
    ])
  })

  it('stops background tasks without interrupting the foreground turn or writing a row', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-background-task-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      adapter: { cancelTurn, stopBackgroundTasks } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }

    const result = await runTargetedCancel(acceptedStop(ctx), {
      clientOperationId: 'cancel-background-tasks',
      turnId: 'background-tasks',
      scope: 'background-tasks',
      childWork: () => [liveTask('task-1'), liveTask('task-2', { stoppable: false })]
    })

    expect(result).toEqual({
      ok: true,
      value: { turnId: 'background-tasks', cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fence: 1,
      taskIds: ['task-1'],
      acknowledge: expect.any(Function)
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(journal.snapshot().items).toEqual([])
  })

  it('routes one background task id without interrupting the foreground turn or writing a row', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-background-task-targeted-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const stopBackgroundTasks = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      adapter: { cancelTurn, stopBackgroundTasks } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }

    const result = await runTargetedCancel(acceptedStop(ctx), {
      clientOperationId: 'cancel-background-task-2',
      turnId: 'background-tasks',
      scope: 'background-tasks',
      taskId: 'task-2',
      childWork: () => [liveTask('task-1'), liveTask('task-2')]
    })

    expect(result).toEqual({
      ok: true,
      value: { turnId: 'background-tasks', cancelled: true }
    })
    expect(stopBackgroundTasks).toHaveBeenCalledWith({
      sessionId: 'session-1',
      fence: 1,
      taskIds: ['task-2'],
      acknowledge: expect.any(Function)
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    expect(journal.snapshot().items).toEqual([])
  })

  it('omits an earlier listed Stop when its same-ID lifetime restarts during acceptance', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-background-stop-lifetime-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const owner = new StructuredAgentSessionStatusOwnership(() => undefined)
    const live = (restart = false): AgentChildWorkEvidence => ({
      type: 'live',
      observedAt: 1,
      child: {
        handle: { idKind: 'task_id', id: 'helper', runId: 'spawn-a' },
        kind: 'agent',
        residency: 'background',
        state: 'working',
        stoppable: true
      },
      ...(restart ? { restart: true as const } : {})
    })
    owner.publishChildWork('session-1', [live()], 'claude')
    let acceptStop: (() => void) | undefined
    const accepting = new Promise<void>((resolve) => {
      acceptStop = resolve
    })
    const stopBackgroundTasks = vi.fn(
      async (request: { acknowledge: (value: { taskId: string }) => void }) => {
        request.acknowledge({ taskId: 'helper' })
        return { cancelled: true }
      }
    )
    const ctx = acceptedStop({
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This path calls only stopBackgroundTasks on the test adapter.
      adapter: { stopBackgroundTasks } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    })
    ctx.operationReceipt!.commitAlone = () => accepting
    const stopping = runTargetedCancel(ctx, {
      clientOperationId: 'stop-earlier-lifetime',
      scope: 'background-tasks',
      childWork: () => [
        liveTask('helper', { invocation: { invocationId: 'spawn-a', generation: 1 } })
      ],
      captureStops: (targets) =>
        owner.captureChildWorkStops(
          'session-1',
          targets.map((target) => target.providerId)
        ),
      acknowledgeStops: (evidence) => owner.publishChildWork('session-1', evidence, 'claude')
    })
    expect(stopBackgroundTasks).not.toHaveBeenCalled()
    owner.publishChildWork('session-1', [live(true)], 'claude')
    acceptStop?.()
    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: false } })
    expect(stopBackgroundTasks).not.toHaveBeenCalled()
    expect(owner.childWorkOpen('session-1')).toBe(true)
  })

  it('does not close the agent when a refused helper appears during a listed Stop all', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-background-stop-refused-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const server = new AgentHookServer()
    let refuse = false
    const owner = new StructuredAgentSessionStatusOwnership(() => ({
      publish: (summary, subject) => server.ingestStructuredStatus(summary, subject),
      forget: (subject) => server.dropStructuredStatus(subject),
      publishChildWork: (subject, evidence, provider) => {
        if (!refuse) {
          server.ingestStructuredChildWork(subject, evidence, provider)
        }
      },
      readChildWork: (subject) => server.getStructuredChildWorkViews(subject),
      readChildWorkHandles: (subject) => server.getStructuredChildWorkHandles(subject)
    }))
    const location: AgentSessionExecutionLocation = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'folder'
    }
    const summary: AgentSessionStatusSummary = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      agent: 'claude',
      status: 'idle',
      latestPrompt: 'fixture',
      updatedAt: 1
    }
    const live = (runId: string): AgentChildWorkEvidence => ({
      type: 'live',
      observedAt: 1,
      child: {
        handle: { idKind: 'task_id', id: 'helper', runId },
        kind: 'agent',
        residency: 'background',
        state: 'working',
        stoppable: true
      }
    })
    owner.publish(summary, location)
    owner.publishChildWork('session-1', [live('spawn-a')], 'claude')
    expect(owner.readChildWork('session-1')).toHaveLength(1)
    expect(owner.childWorkIncomplete('session-1')).toBe(false)

    let releaseStop: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      releaseStop = resolve
    })
    let stopStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      stopStarted = resolve
    })
    const stopBackgroundTasks = vi.fn(
      async (request: { acknowledge: (value: { taskId: string }) => void }) => {
        stopStarted?.()
        await waiting
        request.acknowledge({ taskId: 'helper' })
        return { cancelled: true }
      }
    )
    const stopAgent = vi.fn(async () => {})
    const ctx = acceptedStop({
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'claude',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This path calls only stopBackgroundTasks on the test adapter.
      adapter: { stopBackgroundTasks } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    })
    const stopping = runTargetedCancel(ctx, {
      clientOperationId: 'stop-all-before-refusal',
      scope: 'background-tasks',
      childWork: () => owner.readChildWork('session-1'),
      captureStops: (targets) =>
        owner.captureChildWorkStops(
          'session-1',
          targets.map((target) => target.providerId)
        ),
      acknowledgeStops: (evidence) => owner.publishChildWork('session-1', evidence, 'claude'),
      unlisted: { present: () => owner.childWorkIncomplete('session-1'), stop: stopAgent }
    })
    await started
    refuse = true
    owner.publishChildWork('session-1', [live('spawn-b')], 'claude')
    refuse = false
    releaseStop?.()
    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: true } })
    expect(owner.childWorkIncomplete('session-1')).toBe(true)
    expect(owner.childWorkOpen('session-1')).toBe(true)
    expect(stopAgent).not.toHaveBeenCalled()
  })

  async function backgroundStopWith(
    stopBackgroundTasks: StructuredAgentSessionAdapter['stopBackgroundTasks'],
    operation: string,
    acknowledgeStops?: (evidence: AgentChildWorkEvidence[]) => void,
    /** Untargeted Stop includes work missing from the listed records. */
    untargeted?: {
      unlisted: { present: () => boolean; stop: () => Promise<void> }
      listed: AgentChildWorkView[]
      onJournal?: (journal: AgentSessionJournal) => void
    }
  ) {
    root = await mkdtemp(join(tmpdir(), 'orca-background-task-failed-cancel-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    untargeted?.onJournal?.(journal)
    const cancelTurn = vi.fn(async () => ({ cancelled: true }))
    const ctx: AgentSessionTurnContext = {
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      adapter: { cancelTurn, stopBackgroundTasks } as unknown as StructuredAgentSessionAdapter,
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }
    const result = await runTargetedCancel(acceptedStop(ctx), {
      clientOperationId: operation,
      turnId: 'background-tasks',
      scope: 'background-tasks',
      ...(untargeted
        ? { unlisted: untargeted.unlisted, childWork: () => untargeted.listed }
        : { taskId: 'task-1', childWork: () => [liveTask('task-1')] }),
      ...(acknowledgeStops ? { acknowledgeStops } : {})
    })
    expect(cancelTurn).not.toHaveBeenCalled()
    return { result, items: journal.snapshot().items }
  }

  it('ends the agent only for work unlisted at capture and while no lead turn runs', async () => {
    const stop = vi.fn(async () => {})
    const initiallyUnlisted = await backgroundStopWith(
      async () => ({ cancelled: false }),
      'cancel-background-initially-unlisted',
      undefined,
      { unlisted: { present: () => true, stop }, listed: [liveTask('task-1')] }
    )
    expect(initiallyUnlisted.result).toEqual({
      ok: true,
      value: { turnId: 'background-tasks', cancelled: true }
    })
    expect(stop).toHaveBeenCalledOnce()

    // Turns opened during background cancellation must survive that Stop.
    let journal: AgentSessionJournal | undefined
    const woke = await backgroundStopWith(
      async () => {
        await journal!.appendItem(
          {
            provider: 'legacy',
            agent: 'codex',
            sessionId: 'session-1',
            recordId: 'turn-lifecycle:woke'
          },
          {
            kind: 'status',
            text: 'Agent is working…',
            turnLifecycle: { turnId: 'woke', state: 'running' }
          },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        return { cancelled: false }
      },
      'cancel-background-unlisted-woke',
      undefined,
      {
        unlisted: { present: () => true, stop },
        listed: [liveTask('task-1')],
        onJournal: (opened) => (journal = opened)
      }
    )
    expect(woke.result).toEqual({
      ok: true,
      value: { turnId: 'background-tasks', cancelled: false }
    })
    expect(woke.items).toHaveLength(1)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('ends the agent for unlisted work with nothing listed, never asking an agent that has no stop', async () => {
    const stop = vi.fn(async () => {})
    const stopBackgroundTasks = vi.fn(async () => {
      throw new Error('ACP child cancellation is unavailable')
    })
    const { result, items } = await backgroundStopWith(
      stopBackgroundTasks,
      'cancel-background-unlisted-acp',
      undefined,
      {
        unlisted: { present: () => true, stop },
        listed: []
      }
    )
    expect(result).toEqual({ ok: true, value: { turnId: 'background-tasks', cancelled: true } })
    expect(items).toEqual([])
    expect(stopBackgroundTasks).not.toHaveBeenCalled()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('ends a run the agent accepted the stop of, even when a later stop in the batch fails', async () => {
    const acknowledgeStops = vi.fn()
    const { result, items } = await backgroundStopWith(
      async ({ acknowledge }) => {
        acknowledge?.({ taskId: 'task-1' })
        throw new Error('claude control request timed out')
      },
      'cancel-background-task-partial',
      acknowledgeStops
    )

    expect(result).toEqual({ ok: true, value: { turnId: 'background-tasks', cancelled: false } })
    expect(items).toHaveLength(1)
    expect(acknowledgeStops).toHaveBeenCalledWith([
      expect.objectContaining({ type: 'stop-acknowledged', childWorkId: 'child-task-1' })
    ])
  })
})

function acceptedStop(ctx: AgentSessionTurnContext): AgentSessionTurnContext {
  return {
    ...ctx,
    operationReceipt: {
      write: () => {},
      committed: () => {},
      isCommitted: () => true,
      commitAlone: async () => {}
    }
  }
}

function liveTask(
  providerId: string,
  overrides: Partial<AgentChildWorkView> = {}
): AgentChildWorkView {
  return {
    id: `child-${providerId}`,
    providerId,
    kind: 'agent',
    state: 'working',
    membership: 'live',
    firstObservedAt: 1,
    observedAt: 1,
    stoppable: true,
    invocation: { invocationId: `spawn-${providerId}`, generation: 1 },
    ...overrides
  }
}

describe('what a conversation Stop reports when the provider stopped nothing', () => {
  async function cancelWith(
    outcome: Awaited<ReturnType<StructuredAgentSessionAdapter['cancelTurn']>>,
    input: { turnId?: string; withdrewQueued?: boolean },
    turnRow: 'none' | 'running' | 'landing' = 'none'
  ) {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-report-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const openTurn = () =>
      journal.appendItem(
        {
          provider: 'legacy',
          agent: 'codex',
          sessionId: 'session-1',
          recordId: 'turn-lifecycle:turn-1'
        },
        {
          kind: 'status',
          text: 'Agent is working…',
          turnLifecycle: { turnId: 'turn-1', state: 'running' }
        },
        { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
      )
    if (turnRow === 'running') {
      await openTurn()
    }
    // Issue without awaiting: Stop must queue its read behind this turn write.
    const landing = turnRow === 'landing' ? openTurn() : null
    const ctx: AgentSessionTurnContext = {
      logger: createStructuredAgentSessionLogger(),
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      adapter: {
        acquire: vi.fn(),
        open: vi.fn(),
        dispatch: vi.fn(),
        closeSession: vi.fn(),
        cancelTurn: vi.fn(async () => outcome),
        answerPrompt: vi.fn(),
        setOption: vi.fn()
      },
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      now: () => 1
    }
    const { withdrewQueued, ...named } = input
    const result = await performCancel(ctx, {
      clientOperationId: 'cancel-report-1',
      ...named,
      ...(withdrewQueued === undefined ? {} : { withdrewQueued: Promise.resolve(withdrewQueued) })
    })
    await landing
    const rows = journal
      .snapshot()
      .items.flatMap((item) =>
        item.body.kind === 'status' && !item.body.turnLifecycle ? [item.body.text] : []
      )
    return { cancelled: result.ok && result.value.cancelled, rows }
  }

  it('reports a Stop naming no turn that withdrew what was queued, with nothing left working, as a success', async () => {
    expect(await cancelWith({ cancelled: false }, { withdrewQueued: true })).toEqual({
      cancelled: true,
      rows: []
    })
  })

  it('keeps a Stop naming no turn not cancelled while the journal still reads working', async () => {
    const reported = await cancelWith({ cancelled: false }, { withdrewQueued: true }, 'running')
    expect(reported.cancelled).toBe(false)
    expect(reported.rows).toHaveLength(1)
    expect(reported.rows).not.toContain('The provider had already finished this turn.')
  })

  it('reads the journal behind its streamed rows: a turn whose send was accepted first is still working', async () => {
    const reported = await cancelWith(
      { cancelled: false },
      { turnId: 'turn-0', withdrewQueued: true },
      'landing'
    )
    expect(reported).toEqual({ cancelled: false, rows: [] })
  })
})

describe('the note a Stop writes', () => {
  it('belongs to the turn whose row was emitted just before the Stop, with no flush', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-turn-cancel-note-scope-'))
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const deferred = createDeferredStructuredAgentSessionEventSink(testEventSinkLogging())
    deferred.bind({ journal, fence: 1, publish: () => {} })
    const turnIdentity = {
      provider: 'legacy' as const,
      agent: 'codex' as const,
      sessionId: 'session-1',
      recordId: 'turn-lifecycle:turn-1'
    }
    // Model an earlier stream row still ahead of the named turn.
    deferred.sink.appendItem(
      { provider: 'codex', threadId: 'thread-1', turnId: 'turn-0', ordinal: 0 },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Earlier.' }] },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    deferred.sink.appendItem(
      turnIdentity,
      {
        kind: 'status',
        text: 'Agent is working…',
        turnLifecycle: { turnId: 'turn-1', state: 'running' }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    const ctx: AgentSessionTurnContext = {
      sessionId: 'session-1',
      journal,
      fence: 1,
      agents: NO_STRUCTURED_AGENTS,
      agent: 'codex',
      adapter: {
        acquire: vi.fn(),
        open: vi.fn(),
        dispatch: vi.fn(),
        closeSession: vi.fn(),
        cancelTurn: vi.fn(async () => ({ cancelled: true })),
        answerPrompt: vi.fn(),
        setOption: vi.fn()
      },
      persistOptions: async () => undefined,
      resolvedBy: 'client-1',
      publish: vi.fn(),
      logger: createStructuredAgentSessionLogger(),
      now: () => 1
    }

    await performCancel(ctx, { clientOperationId: 'cancel-scope-1', turnId: 'turn-1' })
    await deferred.drained()

    const note = journal
      .snapshot()
      .items.find(
        (item) => item.body.kind === 'status' && item.body.text === 'Cancellation requested.'
      )
    expect(note?.turnScope).toEqual({ kind: 'turn', turnItemId: agentJournalItemKey(turnIdentity) })
  })
})
