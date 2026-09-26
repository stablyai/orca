import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PROVIDER_SESSION_ID,
  adapterFor,
  fakeClaude,
  identityFor
} from '../../claude/claude-structured-session-test-support'
import { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import { createTrackedJournalOpener } from '../agent-session-journal/journal-store-test-open'
import type { AgentSessionAttachParams } from './structured-agent-session-attach'
import { evictHeldStructuredAgentSession } from './structured-agent-session-host-lifetime'
import { StructuredAgentSessionHostRuntimeState } from './structured-agent-session-host-runtime-state'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

const NOW = 1_788_727_031_330
const roots: string[] = []
const journals = createTrackedJournalOpener()

afterEach(async () => {
  await journals.closeAll()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Claude root-exit eviction', () => {
  it('releases a captured live claim after the provider root exits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-root-exit-'))
    roots.push(root)
    const store = await AgentSessionRecordStore.open({ directory: root, hostId: 'local' })
    const claude = fakeClaude({
      unprovenCloseVerdict: { root: 'exited', tree: 'unverifiable' }
    })
    const adapter = adapterFor(claude)
    const reservation = await store.reserveOwner({
      sessionId: 'session-1',
      location: {
        executionHostId: 'local',
        workspaceId: 'folder-1',
        workspaceKind: 'folder',
        wslDistro: null
      },
      provider: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
      expectedFence: null,
      spawnToken: 'spawn-1',
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
    const fence = reservation.record.lease.runtimeFence
    const acquisition = await adapter.acquire({
      identity: { ...identityFor(), hostId: 'local', workspaceId: 'folder-1' },
      fence,
      spawnToken: 'spawn-1'
    })
    await store.commitProcessIdentity({
      sessionId: 'session-1',
      fence,
      process: acquisition.process,
      now: NOW
    })
    await store.proveOwner({
      sessionId: 'session-1',
      fence,
      link: acquisition.link,
      now: NOW
    })
    const journal = await journals.open({
      identity: { ...identityFor(), hostId: 'local', workspaceId: 'folder-1' },
      journalDir: join(root, 'journal')
    })
    const close = vi.spyOn(journal, 'close')
    const params: AgentSessionAttachParams = {
      envelope: {
        sessionId: 'session-1',
        clientOperationId: `${NOW}-00000000000000000000000000000001`,
        expectedRuntimeFence: fence,
        payloadFingerprint: 'create'
      },
      location: {
        executionHostId: 'local',
        workspaceId: 'folder-1',
        workspaceKind: 'folder',
        wslDistro: null
      },
      provider: 'claude',
      agent: 'claude',
      accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: root },
      runtimeKind: 'native',
      providerHandle: { kind: 'claude', sessionId: PROVIDER_SESSION_ID, leafUuid: null }
    }
    const sessions = new Map<string, StructuredAgentSessionHostSession>([
      [
        'session-1',
        {
          journal,
          params,
          child: {
            generation: acquisition.acquisitionGeneration ?? null,
            fence,
            phase: 'ready'
          }
        }
      ]
    ])
    const deps = { store, adapter, journalRoot: root, claimKeyId: 'key-1' }
    const runtimeState = new StructuredAgentSessionHostRuntimeState(deps)

    claude.connections[0]!.handlers.onExit?.(new Error('provider exited'))
    await expect(
      evictHeldStructuredAgentSession(
        {
          deps,
          runtimeState,
          sessions,
          now: () => NOW + 30 * 60_000,
          forgetStatus: vi.fn()
        },
        'session-1'
      )
    ).resolves.toBeUndefined()

    expect(store.getRecord('session-1')?.lease).toMatchObject({
      claimStatus: 'released',
      ownerProcess: null,
      deathEvidence: { kind: 'exit-observed' }
    })
    expect(sessions.size).toBe(0)
    expect(close).toHaveBeenCalledOnce()
    // The adapter agrees the session is over: nothing is left to refuse the next start.
    await expect(adapter.closeSession('session-1')).resolves.toBe(true)
  })
})
