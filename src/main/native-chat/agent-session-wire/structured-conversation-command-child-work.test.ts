// A conversation command is refused for background work only when the chat strip lists that work:
// both read the host's child records through the one sink read. The provider tracker's own roster
// is present and claims live work throughout; nothing here may be decided by it.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionBackgroundTaskState } from '../../../shared/agent-session-wire'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionStatusSink } from './structured-agent-session-status-feed'
import {
  HOST_TEST_NOW,
  HOST_TEST_SESSION,
  hostTestAttachParams,
  hostTestOperationId,
  resetHostTestOperationIds
} from './structured-agent-session-host-test-data'

const caller = { callerKey: 'desktop' }
let directory: string
let store: AgentSessionRecordStore
let host: StructuredAgentSessionHost
const compact = vi.fn<NonNullable<StructuredAgentSessionAdapter['compact']>>()
/** What the store holds for the session; the sink serves it to every reader. */
let records: AgentChildWorkView[] = []

function compactParams() {
  return {
    command: 'compact' as const,
    envelope: {
      sessionId: HOST_TEST_SESSION,
      clientOperationId: hostTestOperationId(),
      expectedRuntimeFence: store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.conversationCommand',
        sessionId: HOST_TEST_SESSION,
        fields: { command: 'compact' }
      })
    }
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

beforeEach(async () => {
  records = []
  resetHostTestOperationIds()
  compact.mockReset().mockResolvedValue({})
  directory = await mkdtemp(join(tmpdir(), 'orca-command-child-work-'))
  store = await AgentSessionRecordStore.open({
    directory: join(directory, 'store'),
    hostId: 'local'
  })
  const statusSink: StructuredAgentSessionStatusSink = {
    publish: () => {},
    forget: () => {},
    publishChildWork: () => {},
    readChildWork: () => records
  }
  const trackerRoster: AgentSessionBackgroundTaskState = {
    state: 'monitoring',
    tasks: [{ id: 'tracker-only', kind: 'command', description: 'not on the strip' }]
  }
  const adapter = {
    supportsLocation: () => true,
    acquire: vi.fn(async (input: Parameters<StructuredAgentSessionAdapter['acquire']>[0]) => ({
      process: {
        hostId: 'local',
        pid: 4001,
        processStartTimeMs: HOST_TEST_NOW,
        spawnToken: input.spawnToken
      },
      link: {
        linkId: 'link-1',
        mintedAtFence: input.fence,
        observedAt: HOST_TEST_NOW,
        origin: 'created' as const,
        handle: { provider: 'codex' as const, threadId: '00000000-0000-4000-8000-000000000001' }
      }
    })),
    dispatch: vi.fn(async () => ({ state: 'unknown' as const, reason: 'test' })),
    cancelTurn: vi.fn(async () => ({ cancelled: true })),
    answerPrompt: async () => {},
    setOption: async () => {},
    compact,
    releaseAcquisition: async () => true,
    closeSession: async () => true,
    readOptions: async () => ({ models: [], current: { model: 'test-model', effort: 'high' } }),
    backgroundTaskStops: () => ({ supportsTaskStop: true, supportsStopAll: true }),
    // A tracker that drifted from the records: it still claims work the strip does not list.
    backgroundTaskState: () => trackerRoster
  }
  host = new StructuredAgentSessionHost({
    store,
    adapter,
    journalRoot: directory,
    claimKeyId: 'key',
    now: () => HOST_TEST_NOW,
    mintSpawnToken: () => 'spawn-1',
    statusSink
  })
  expect(await host.attach(caller, hostTestAttachParams(null))).toMatchObject({ ok: true })
})

afterEach(async () => {
  await host.flushAllStreamedEvents()
  await rm(directory, { recursive: true, force: true })
})

describe('conversation command admission reads the strip’s child records', () => {
  it('refuses only while the strip lists live work, and names the stop the strip offers', async () => {
    const strip: (AgentSessionBackgroundTaskState | null)[] = []
    host.subscribe({
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

    // Nothing on the strip: the drifted tracker's roster refuses nothing.
    expect(stripRows()).toEqual([])
    expect(await host.conversationCommand(caller, compactParams())).toMatchObject({ ok: true })
    expect(compact).toHaveBeenCalledTimes(1)

    records = [devServer()]
    host.publishChildWorkEvidence(HOST_TEST_SESSION, [])
    expect(stripRows()).toEqual([
      { description: 'npm run dev', membership: 'live', stoppable: true, providerId: 'task-dev' }
    ])
    expect(await host.conversationCommand(caller, compactParams())).toMatchObject({
      ok: false,
      refusal: { message: 'Stop background tasks before using this command.' }
    })

    records = [devServer({ state: 'done', membership: 'settled', outcome: 'succeeded' })]
    host.publishChildWorkEvidence(HOST_TEST_SESSION, [])
    // Still listed, as finished: a finished row blocks nothing.
    expect(stripRows()).toEqual([
      { description: 'npm run dev', membership: 'settled', stoppable: true, providerId: 'task-dev' }
    ])
    expect(await host.conversationCommand(caller, compactParams())).toMatchObject({ ok: true })
    expect(compact).toHaveBeenCalledTimes(2)
  })
})
