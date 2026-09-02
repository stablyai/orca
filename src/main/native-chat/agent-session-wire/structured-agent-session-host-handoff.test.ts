import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentSessionExecutionLocation,
  AgentSessionRecord
} from '../../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store-factory'
import { createDeferredStructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import {
  acquireNativeHandoffOwner,
  structuredTuiTranscriptImportOptions
} from './structured-agent-session-host-handoff'

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
    const journal = await openAgentSessionJournal({
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
