import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import type { AgentSessionHandoffStatus } from '../../../shared/agent-session-wire'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import {
  acquireNativeHandoffOwner,
  createStructuredAgentSessionHostHandoff,
  structuredTuiTranscriptImportOptions
} from './structured-agent-session-host-handoff'

const journals = createTrackedJournalOpener()

function importRecord(provider: 'claude' | 'codex', accountHome: string): AgentSessionRecord {
  return {
    provider,
    accountHome: {
      variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
      path: accountHome
    }
  } as AgentSessionRecord
}

describe('structured TUI transcript import roots', () => {
  it('uses the managed Claude account home when no live transcript path remains', () => {
    expect(structuredTuiTranscriptImportOptions(importRecord('claude', '/managed/claude'))).toEqual(
      {
        claudeProjectsDir: join('/managed/claude', 'projects')
      }
    )
  })

  it('uses the managed Codex account home when no live transcript path remains', () => {
    expect(structuredTuiTranscriptImportOptions(importRecord('codex', '/managed/codex'))).toEqual({
      codexSessionsDirs: [join('/managed/codex', 'sessions')]
    })
  })
})

describe('native handoff acquisition', () => {
  const sessionId = 'session-handoff-drain'
  const threadId = 'thread-handoff-drain'
  const now = 1_800_000_000_000
  let root: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-native-handoff-'))
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  })

  afterEach(async () => {
    await journals.closeAll()
    await rm(root, { recursive: true, force: true })
  })

  it('drains queued rows before unbinding the old target and acquiring the native child', async () => {
    const location: AgentSessionExecutionLocation = {
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree' as const
    }
    const reserved = await store.reserveOwner({
      sessionId,
      location,
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
      runtimeKind: 'native',
      expectedFence: null,
      spawnToken: 'native-handoff',
      claimKeyId: 'key-1',
      handoffOperationId: `${now}-00000000000000000000000000000001`,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'test',
        operationId: `${now}-00000000000000000000000000000002`,
        fingerprint: 'handoff'
      },
      now
    })
    const journal = await journals.open({
      identity: {
        sessionId,
        workspaceId: location.workspaceId,
        hostId: location.executionHostId,
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId }
      },
      journalDir: join(root, 'journal')
    })
    const eventSink = createDeferredStructuredAgentSessionEventSink()
    const order: string[] = []
    const appendEntered = Promise.withResolvers<void>()
    const appendGate = Promise.withResolvers<void>()
    const originalAppend = journal.appendItem.bind(journal)
    vi.spyOn(journal, 'appendItem').mockImplementationOnce(async (...args) => {
      order.push('append-entered')
      appendEntered.resolve()
      await appendGate.promise
      const result = await originalAppend(...args)
      order.push('append-complete')
      return result
    })
    eventSink.bind({
      journal,
      fence: reserved.record.lease.runtimeFence,
      publish: () => undefined
    })
    eventSink.sink.appendItem(
      { provider: 'orca', clientMessageId: 'queued-before-handoff' },
      { kind: 'status', text: 'queued before handoff' }
    )
    await appendEntered.promise
    const originalUnbind = eventSink.unbind.bind(eventSink)
    const unbind = vi.spyOn(eventSink, 'unbind').mockImplementation(() => {
      order.push('unbind')
      originalUnbind()
    })
    const adapter = {
      acquire: vi.fn(async ({ fence, spawnToken }) => {
        order.push('acquire')
        return {
          process: {
            hostId: 'local',
            pid: 5300,
            processStartTimeMs: now - 1_000,
            spawnToken
          },
          link: {
            linkId: 'native-link',
            handle: { provider: 'codex' as const, threadId },
            origin: 'created' as const,
            mintedAtFence: fence,
            observedAt: now
          },
          acquisitionGeneration: 'generation-native'
        }
      })
    }
    const session = {
      journal,
      params: {
        envelope: {
          sessionId,
          clientOperationId: `${now}-00000000000000000000000000000003`,
          expectedRuntimeFence: reserved.record.lease.runtimeFence,
          payloadFingerprint: 'handoff'
        },
        location,
        provider: 'codex' as const,
        agent: 'codex' as const,
        accountHome: { variable: 'CODEX_HOME' as const, path: join(root, 'codex-home') },
        runtimeKind: 'native' as const,
        providerHandle: { kind: 'codex' as const, threadId }
      },
      fence: reserved.record.lease.runtimeFence,
      hasProviderChild: false,
      acquisitionGeneration: null
    }
    const acquiring = acquireNativeHandoffOwner(
      {
        store,
        adapter: adapter as never,
        journalRoot: root,
        claimKeyId: 'key-1'
      },
      {
        session: () => session,
        findSession: () => session,
        eventSink: () => eventSink,
        flush: async () => undefined,
        serialize: async (_session, task) => task(),
        subscribers: {
          publish: vi.fn(),
          reset: vi.fn(),
          handoff: vi.fn(),
          snapshot: vi.fn()
        } as never,
        now: () => now
      },
      {
        sessionId,
        fence: reserved.record.lease.runtimeFence,
        spawnToken: 'native-handoff'
      }
    )
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(adapter.acquire).not.toHaveBeenCalled()
    expect(unbind).not.toHaveBeenCalled()

    appendGate.resolve()
    await acquiring

    expect(order).toEqual(['append-entered', 'append-complete', 'unbind', 'acquire'])
  })
})

describe('handoff status published for a session the host no longer holds', () => {
  const sessionId = 'session-handoff-publish-detached'
  const now = 1_800_000_000_000
  const failed: AgentSessionHandoffStatus = {
    owner: 'native',
    direction: 'to-tui',
    phase: 'failed',
    stage: null,
    operationId: null
  }
  let root: string
  let store: AgentSessionRecordStore

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-handoff-publish-'))
    store = await AgentSessionRecordStore.open({ directory: join(root, 'store'), hostId: 'local' })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function detachedHandoff(frames: { fence: number; status: AgentSessionHandoffStatus }[]) {
    return createStructuredAgentSessionHostHandoff(
      { store, adapter: {} as never, journalRoot: root, claimKeyId: 'key-1' },
      {
        // Eviction and host teardown both drop the map entry while a flow is still settling.
        session: () => {
          throw new Error('agent_session_ownership_unknown')
        },
        findSession: () => undefined,
        eventSink: () => {
          throw new Error('unreachable: publishing reads no sink')
        },
        flush: async () => undefined,
        serialize: async (_sessionId, task) => task(),
        subscribers: {
          publish: vi.fn(),
          reset: vi.fn(),
          snapshot: vi.fn(),
          handoff: (_id: string, fence: number, status: AgentSessionHandoffStatus) =>
            void frames.push({ fence, status })
        } as never,
        now: () => now
      }
    )
  }

  it('still reaches subscribers at the record fence instead of throwing', async () => {
    const reserved = await store.reserveOwner({
      sessionId,
      location: {
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
      runtimeKind: 'native',
      expectedFence: null,
      spawnToken: 'detached-publish',
      claimKeyId: 'key-1',
      handoffOperationId: `${now}-00000000000000000000000000000001`,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'test',
        operationId: `${now}-00000000000000000000000000000002`,
        fingerprint: 'handoff'
      },
      now
    })
    const frames: { fence: number; status: AgentSessionHandoffStatus }[] = []

    expect(() => detachedHandoff(frames).setStatus(sessionId, failed)).not.toThrow()

    expect(frames).toEqual([{ fence: reserved.record.lease.runtimeFence, status: failed }])
  })

  it('drops the publish when neither a session nor a record remains', () => {
    const frames: { fence: number; status: AgentSessionHandoffStatus }[] = []

    expect(() => detachedHandoff(frames).setStatus(sessionId, failed)).not.toThrow()

    expect(frames).toEqual([])
  })
})
