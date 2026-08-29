import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { setStoredAgentSessionHandoffStage } from '../../runtime/agent-session-handoff-record-transitions'
import { StructuredAgentSessionHandoffCoordinator } from './structured-agent-session-handoff'

const NOW = 1_800_000_000_000
const SESSION = 'session-live-tui-restart'
const THREAD = '019fd532-7c11-7a90-b6de-4e1a2c3d5f60'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('structured session live TUI restart survival', () => {
  it('does not stop a daemon-owned toggle TUI when restart adoption is unavailable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-live-tui-restart-'))
    roots.push(root)
    const store = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
    const reserved = await store.reserveOwner({
      sessionId: SESSION,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'codex',
      accountHome: { variable: 'CODEX_HOME', path: join(root, 'codex-home') },
      runtimeKind: 'tui',
      expectedFence: null,
      spawnToken: 'toggle-tui-spawn',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'test',
        operationId: `${NOW}-00000000000000000000000000000000`,
        fingerprint: 'create'
      },
      now: NOW
    })
    const process = {
      hostId: 'local',
      pid: 4200,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'toggle-tui-spawn'
    }
    await store.commitProcessIdentity({
      sessionId: SESSION,
      fence: reserved.record.lease.runtimeFence,
      process,
      now: NOW
    })
    const record = await store.proveOwner({
      sessionId: SESSION,
      fence: reserved.record.lease.runtimeFence,
      link: {
        linkId: 'toggle-tui-link',
        handle: { provider: 'codex', threadId: THREAD },
        origin: 'created',
        mintedAtFence: reserved.record.lease.runtimeFence,
        observedAt: NOW
      },
      now: NOW
    })
    await setStoredAgentSessionHandoffStage(store, {
      sessionId: SESSION,
      fence: record.lease.runtimeFence,
      stage: 'manual-recovery',
      handoffOperationId: null,
      now: NOW
    })
    const stopRecoveredOwner = vi.fn(async () => undefined)
    const coordinator = new StructuredAgentSessionHandoffCoordinator({
      store,
      claimKeyId: 'key-1',
      transport: {
        hostLabel: 'Test host',
        launchTui: vi.fn(),
        recoverTuiOwner: vi.fn(async () => ({
          terminal: {
            handle: 'term-toggle',
            tabId: 'tab-toggle',
            paneKey: 'tab-toggle:leaf-toggle',
            ptyId: 'pty-toggle'
          },
          process,
          link: record.providerHandleChain.at(-1)!
        })),
        reproveTuiOwner: vi.fn(async () => {
          throw new Error('The owning terminal is not hydrated yet.')
        }),
        probeRecoveredOwner: async () => 'live',
        stopRecoveredOwner,
        waitForTuiExit: vi.fn(),
        waitForTuiIdleOrExit: vi.fn(),
        tuiStatus: () => 'busy'
      },
      session: vi.fn() as never,
      suspendNative: vi.fn(),
      acquireNative: vi.fn(),
      importTuiHistory: vi.fn(),
      publish: vi.fn(),
      schedule: async (_sessionId, task) => task(),
      now: () => NOW
    })

    await coordinator.restore(SESSION)

    expect(stopRecoveredOwner).not.toHaveBeenCalled()
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      runtimeKind: 'tui',
      claimStatus: 'live',
      handoffStage: 'manual-recovery',
      ownerProcess: process
    })
  })

  it('persists the provider leaf returned by Claude re-proof before clearing recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-tui-restart-'))
    roots.push(root)
    const sessionId = 'session-claude-live-tui-restart'
    const store = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
    const reserved = await store.reserveOwner({
      sessionId,
      location: {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'workspace-1',
        workspaceKind: 'git-worktree'
      },
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: join(root, 'claude-home') },
      runtimeKind: 'tui',
      expectedFence: null,
      spawnToken: 'claude-tui-spawn',
      claimKeyId: 'key-1',
      handoffOperationId: null,
      probe: { outcome: 'reservation-unused' },
      operation: {
        callerKey: 'test',
        operationId: `${NOW}-00000000000000000000000000000001`,
        fingerprint: 'create'
      },
      now: NOW
    })
    const process = {
      hostId: 'local',
      pid: 4201,
      processStartTimeMs: NOW - 1_000,
      spawnToken: 'claude-tui-spawn'
    }
    await store.commitProcessIdentity({
      sessionId,
      fence: reserved.record.lease.runtimeFence,
      process,
      now: NOW
    })
    const record = await store.proveOwner({
      sessionId,
      fence: reserved.record.lease.runtimeFence,
      link: {
        linkId: 'claude-created-link',
        handle: { provider: 'claude', sessionId: 'claude-session', leafUuid: 'leaf-before' },
        origin: 'created',
        mintedAtFence: reserved.record.lease.runtimeFence,
        observedAt: NOW
      },
      now: NOW
    })
    await setStoredAgentSessionHandoffStage(store, {
      sessionId,
      fence: record.lease.runtimeFence,
      stage: 'manual-recovery',
      handoffOperationId: null,
      now: NOW
    })

    const reproofed = {
      terminal: {
        handle: 'term-claude',
        tabId: 'tab-claude',
        paneKey: 'tab-claude:leaf-claude',
        ptyId: 'pty-claude'
      },
      process,
      link: {
        linkId: 'claude-resumed-link',
        handle: {
          provider: 'claude' as const,
          sessionId: 'claude-session',
          leafUuid: 'leaf-after'
        },
        origin: 'resumed' as const,
        mintedAtFence: record.lease.runtimeFence,
        observedAt: NOW + 1
      },
      transcriptPath: join(root, 'claude-home', 'projects', 'session.jsonl')
    }
    const persistTuiProviderHandle = vi.fn(async () => undefined)
    const coordinator = new StructuredAgentSessionHandoffCoordinator({
      store,
      claimKeyId: 'key-1',
      transport: {
        hostLabel: 'Test host',
        launchTui: vi.fn(),
        recoverTuiOwner: vi.fn(async () => ({
          ...reproofed,
          link: record.providerHandleChain.at(-1)!
        })),
        reproveTuiOwner: vi.fn(async () => reproofed),
        probeRecoveredOwner: async () => 'live',
        stopRecoveredOwner: vi.fn(),
        waitForTuiExit: vi.fn(),
        waitForTuiIdleOrExit: vi.fn(),
        tuiStatus: () => 'idle'
      },
      persistTuiProviderHandle,
      session: vi.fn() as never,
      suspendNative: vi.fn(),
      acquireNative: vi.fn(),
      importTuiHistory: vi.fn(),
      publish: vi.fn(),
      schedule: async (_sessionId, task) => task(),
      now: () => NOW
    })

    await coordinator.restore(sessionId)

    expect(persistTuiProviderHandle).toHaveBeenCalledWith({
      sessionId,
      link: reproofed.link,
      now: NOW
    })
    expect(coordinator.status(sessionId)).toMatchObject({ owner: 'tui', phase: 'idle' })
    expect(store.getRecord(sessionId)?.lease).toMatchObject({
      runtimeKind: 'tui',
      claimStatus: 'live',
      handoffStage: null
    })
  })
})
