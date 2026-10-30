// Stop owns captured helper lifetimes only; restarted or newly refused helpers under the same ID are outside its authority.

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
import { createTrackedJournalOpener } from '../agent-session-journal/journal-host-database-test-support'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { runTargetedCancel } from './structured-agent-session-targeted-cancel'
import { createStructuredAgentSessionLogger } from './structured-agent-session-logger'
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

describe('a listed background Stop', () => {
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
})

/** A Stop whose receipt is already saved, as the receipt runner hands a background Stop. */
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

/** A live child record the strip would offer a stop, named by the provider as `providerId`. */
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
