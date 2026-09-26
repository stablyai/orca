import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { RecoveryProvenance } from '../../../shared/cross-machine-recovery-descriptor'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RuntimeStore } from '../runtime-store-contract'
import { createCrossMachineRecoveryHost } from './recovery-runtime-host'

const WT = 'repo-1::/work/app'

const record: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:3c2b1a00-0000-4000-8000-000000000001',
  tabId: 'tab-1',
  worktreeId: WT,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'session-1' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 1,
  launchConfig: { agentArgs: '', agentEnv: {} },
  origin: 'recovery',
  restoreOnTabOpenOnly: false,
  recovery: { importKey: 'key', sourcePaneKey: 'src-tab:src-leaf' }
}

const provenance: RecoveryProvenance = {
  importKey: 'key',
  checkpointId: 'ckpt-1',
  importedAt: 2,
  source: {
    runtimeId: 'runtime-a',
    machineName: 'laptop',
    platform: 'darwin',
    appVersion: '1.0.0',
    worktreeId: 'repo-1::/src/app',
    instanceId: 'inst-a',
    path: '/src/app',
    exportedAt: 1
  },
  presentationSource: { kind: 'host-layout' }
}

type DurableMutation<T> = () => { value: T; persist?: boolean; rollback?: () => void }

// Why a class: its methods read `this`, as the real Store's durable writer does.
class ReceiverCheckedStore {
  private session: WorkspaceSessionState = getDefaultWorkspaceSession()
  private meta: Record<string, { recoveryProvenance?: RecoveryProvenance }> = {}
  private failNextWrite = false
  readonly durableProvenance: (RecoveryProvenance | undefined)[] = []

  failNextDurableWrite(): void {
    this.failNextWrite = true
  }

  getWorkspaceSession(): WorkspaceSessionState {
    return this.session
  }

  setWorkspaceSession(session: WorkspaceSessionState): void {
    this.session = session
  }

  getWorktreeMeta(worktreeId: string): { recoveryProvenance?: RecoveryProvenance } | undefined {
    return this.meta[worktreeId]
  }

  setWorktreeMeta(worktreeId: string, meta: { recoveryProvenance?: RecoveryProvenance }): void {
    this.meta[worktreeId] = { ...this.meta[worktreeId], ...meta }
  }

  async runDurableMutation<T>(mutate: DurableMutation<T>): Promise<T> {
    const { value, persist, rollback } = mutate()
    if (persist === false) {
      return value
    }
    if (this.failNextWrite) {
      this.failNextWrite = false
      rollback?.()
      throw new Error('write failed')
    }
    this.durableProvenance.push(this.meta[WT]?.recoveryProvenance)
    return value
  }
}

function statusRow(connectionId: string | null): AgentStatusIpcPayload {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: isProviderSessionLive reads only these three fields.
  return {
    connectionId,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' }
  } as unknown as AgentStatusIpcPayload
}

function setup(snapshot: readonly AgentStatusIpcPayload[] = []) {
  const store = new ReceiverCheckedStore()
  const host = createCrossMachineRecoveryHost({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the host reads only the session, meta and durable-writer members this double implements.
    store: store as unknown as RuntimeStore,
    getAuthoritativeWindow: () => null,
    getAgentStatusSnapshot: () => snapshot,
    listLocalRepos: () => [],
    addRepo: async () => ({ id: 'repo-1' }),
    invalidateWorktreeCatalog: () => {},
    resolveWorktree: async () => ({ id: WT, repoId: 'repo-1', instanceId: 'inst-local' }),
    ensureAgentSession: async () => {
      throw new Error('unused')
    },
    activateWorktree: async () => {}
  })
  return { store, host }
}

describe('cross-machine recovery runtime host', () => {
  it('applies headless ops through Store methods that read their receiver', async () => {
    const { store, host } = setup()

    const outcome = await host.applyOp({ kind: 'merge-records', records: [record] })

    expect(outcome.ok).toBe(true)
    expect(store.getWorkspaceSession().sleepingAgentSessionsByPaneKey?.[record.paneKey]).toEqual(
      record
    )
  })

  it('counts only local agent rows as a live provider session', () => {
    const binding = { agent: 'claude' as const, key: 'session_id' as const, id: 'session-1' }

    expect(setup([statusRow('ssh-target-1')]).host.isProviderSessionLive(binding)).toBe(false)
    expect(setup([statusRow(null)]).host.isProviderSessionLive(binding)).toBe(true)
  })

  it('makes recovery provenance durable before resolving', async () => {
    const { store, host } = setup()

    await host.setRecoveryProvenance(WT, provenance)

    expect(store.durableProvenance).toEqual([provenance])
    expect(host.getWorktreeMeta(WT)?.recoveryProvenance).toEqual(provenance)
  })

  it('rejects and restores the previous provenance when the durable write fails', async () => {
    const { store, host } = setup()
    store.failNextDurableWrite()

    await expect(host.setRecoveryProvenance(WT, provenance)).rejects.toThrow('write failed')

    expect(host.getWorktreeMeta(WT)?.recoveryProvenance).toBeUndefined()
  })
})
