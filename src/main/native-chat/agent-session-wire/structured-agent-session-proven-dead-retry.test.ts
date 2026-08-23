import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { AgentSessionHandoffRequest } from '../../../shared/agent-session-wire'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { recoverStoredDeadTuiOwnerForHandoff } from '../../runtime/agent-session-handoff-record-transitions'
import { openAgentSessionJournal } from '../agent-session-journal/journal-store'
import { StructuredAgentSessionHandoffCoordinator } from './structured-agent-session-handoff'
import type { StructuredAgentSessionHandoffTransport } from './structured-agent-session-handoff-types'

const NOW = 1_800_000_000_000
const SESSION = 'session-proven-dead-retry'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const CREATE_OPERATION = `${NOW}-00000000000000000000000000000000`
const OPERATION = `${NOW}-00000000000000000000000000000001`
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('structured session proven-dead TUI retry', () => {
  it('acquires native ownership without trying to close the dead TUI again', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-handoff-dead-retry-'))
    roots.push(root)
    const store = await AgentSessionRecordStore.open({
      directory: join(root, 'store'),
      hostId: 'local'
    })
    const reserved = await store.reserveOwner({
      sessionId: SESSION,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'folder'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
      runtimeKind: 'tui',
      expectedFence: null,
      spawnToken: 'tui-spawn',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: { callerKey: 'test', operationId: CREATE_OPERATION, fingerprint: 'create' },
      now: NOW
    })
    const tuiFence = reserved.record.lease.runtimeFence
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence: tuiFence,
      process: {
        hostId: 'local',
        pid: 4200,
        processStartTimeMs: NOW - 1_000,
        spawnToken: 'tui-spawn'
      },
      now: NOW
    })
    await store.proveOwner({
      sessionId: SESSION,
      fence: tuiFence,
      link: {
        linkId: 'tui-link',
        handle: { provider: 'codex', threadId: THREAD },
        origin: 'created',
        mintedAtFence: tuiFence,
        observedAt: NOW
      },
      now: NOW
    })
    await recoverStoredDeadTuiOwnerForHandoff(store, {
      sessionId: SESSION,
      expectedFence: tuiFence,
      operationId: OPERATION,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })
    const journal = await openAgentSessionJournal({
      identity: {
        sessionId: SESSION,
        workspaceId: 'workspace-1',
        hostId: 'local',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: THREAD }
      },
      journalDir: join(root, 'journal')
    })
    const closeTuiOwner =
      vi.fn<NonNullable<StructuredAgentSessionHandoffTransport['closeTuiOwner']>>()
    const coordinator = new StructuredAgentSessionHandoffCoordinator({
      store,
      claimKeyId: 'key-1',
      transport: {
        hostLabel: 'Test host',
        launchTui: vi.fn(),
        reproveTuiOwner: vi.fn(),
        recoverTuiOwner: vi.fn(),
        stopRecoveredOwner: vi.fn(),
        closeTuiOwner,
        waitForTuiExit: vi.fn(),
        waitForTuiIdleOrExit: vi.fn(),
        tuiStatus: () => 'busy'
      },
      session: () => ({ journal, fence: store.getRecord(SESSION)?.lease.runtimeFence ?? 1 }),
      suspendNative: vi.fn(),
      acquireNative: async ({ fence, spawnToken }) => {
        await store.commitProcessIdentity({
          sessionId: SESSION,
          fence,
          process: {
            hostId: 'local',
            pid: 4300,
            processStartTimeMs: NOW,
            spawnToken
          },
          now: NOW
        })
        return store.proveOwner({
          sessionId: SESSION,
          fence,
          link: {
            linkId: 'native-link',
            handle: { provider: 'codex', threadId: THREAD },
            origin: 'resumed',
            mintedAtFence: fence,
            observedAt: NOW
          },
          now: NOW
        })
      },
      acquireNativeStop: vi.fn(async () => true),
      importTuiHistory: vi.fn(),
      publish: vi.fn(),
      schedule: async (_sessionId, task) => task(),
      now: () => NOW
    })
    const fields = {
      direction: 'to-native' as const,
      mode: 'now' as const,
      action: 'retry' as const
    }
    const request: AgentSessionHandoffRequest = {
      envelope: {
        sessionId: SESSION,
        clientOperationId: OPERATION,
        expectedRuntimeFence: store.getRecord(SESSION)?.lease.runtimeFence ?? null,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.requestHandoff',
          sessionId: SESSION,
          fields
        })
      },
      ...fields
    }

    expect(coordinator.status(SESSION)).toMatchObject({ phase: 'failed', owner: 'tui' })
    expect(await coordinator.request('client-1', request)).toMatchObject({ ok: true })
    await vi.waitFor(() => expect(coordinator.status(SESSION).owner).toBe('native'))
    expect(closeTuiOwner).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'native',
      claimStatus: 'live',
      handoffStage: null
    })
  })
})
