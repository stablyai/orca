import { describe, expect, it, vi } from 'vitest'
import { AgentLaunchPaneAlreadyLiveError } from '../../../shared/agent-launch-pane-already-live'
import { isDormantRecoveryRecord } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { descriptor, emptySession, fixture, SESSION_ID } from './recovery-import.test-fixture'
import { resumeRecoveryBindingWithHost } from './recovery-resume'
import { createRecoveryResumeHolds } from './recovery-resume-holds'
import { createCrossMachineRecoveryHost } from './recovery-runtime-host'

describe('resumeRecoveryBindingWithHost', () => {
  it('restores the claimed record when the launch fails', async () => {
    const f = fixture({
      ensure: async () => {
        throw new Error('spawn_failed')
      }
    })
    await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )
    await expect(
      resumeRecoveryBindingWithHost(f.host, {
        worktree: `id:${f.worktreeId}`,
        binding: SESSION_ID
      })
    ).rejects.toThrow('spawn_failed')
    expect(Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(1)
    await expect(
      resumeRecoveryBindingWithHost(f.host, {
        worktree: `id:${f.worktreeId}`,
        binding: 'missing'
      })
    ).rejects.toThrow('recovery_binding_not_found')
  })

  it('launches claude --resume fresh into the recovered pane instead of adopting its PTY', async () => {
    const f = fixture()
    await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )
    const [record] = Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {})
    const pane = parsePaneKey(record!.paneKey)
    await resumeRecoveryBindingWithHost(f.host, {
      worktree: `id:${f.worktreeId}`,
      binding: SESSION_ID
    })
    expect(f.ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'explicit',
        agent: 'claude',
        providerSession: expect.objectContaining({ id: SESSION_ID }),
        placement: { tabId: pane!.tabId, leafId: pane!.leafId },
        requireFreshPane: true
      })
    )
  })

  it('keeps the dormant record as the pane fence until the launch settles', async () => {
    const recordsDuringLaunch: boolean[] = []
    const f = fixture({
      ensure: async () => {
        recordsDuringLaunch.push(
          ...Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {}).map(
            isDormantRecoveryRecord
          )
        )
        await expect(
          resumeRecoveryBindingWithHost(f.host, {
            worktree: `id:${f.worktreeId}`,
            binding: SESSION_ID
          })
        ).rejects.toThrow('recovery_session_live_locally')
        return {
          terminal: { handle: 'term-1', worktreeId: f.worktreeId, title: null },
          disposition: 'created' as const
        }
      }
    })
    await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )

    await resumeRecoveryBindingWithHost(f.host, {
      worktree: `id:${f.worktreeId}`,
      binding: SESSION_ID
    })

    expect(recordsDuringLaunch).toEqual([true])
    expect(f.getSession().sleepingAgentSessionsByPaneKey).toEqual({})
  })

  it('forwards the imported launch preferences on a deferred Resume', async () => {
    const f = fixture()
    const d = descriptor()
    const launchPreferences = { model: 'opus', effort: 'high', mode: 'plan' }
    d.bindings[0] = { ...d.bindings[0], launch: { ...d.bindings[0].launch, launchPreferences } }
    await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: d, checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )

    await resumeRecoveryBindingWithHost(f.host, {
      worktree: `id:${f.worktreeId}`,
      binding: SESSION_ID
    })

    expect(f.ensureAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ launchPreferences })
    )
  })

  it('fails with recovery_placement_occupied and keeps the record when the pane is already live', async () => {
    const f = fixture({
      ensure: async () => {
        throw new AgentLaunchPaneAlreadyLiveError()
      }
    })
    await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )
    await expect(
      resumeRecoveryBindingWithHost(f.host, {
        worktree: `id:${f.worktreeId}`,
        binding: SESSION_ID
      })
    ).rejects.toThrow('recovery_placement_occupied')
    expect(Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(1)
  })
})

describe('headless runtime writer', () => {
  it('applies import ops through the durable store when no window is attached', async () => {
    let stored = emptySession()
    const store = {
      getWorkspaceSession: () => stored,
      setWorkspaceSession: (next: WorkspaceSessionState) => {
        stored = next
      },
      runDurableMutation: async <T>(fn: () => { value: T }) => fn().value
    }
    const host = createCrossMachineRecoveryHost({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the writer reads only the three session members stubbed above.
      store: store as never,
      getAuthoritativeWindow: () => null,
      getAgentStatusSnapshot: () => [],
      listLocalRepos: () => [],
      addRepo: vi.fn(),
      invalidateWorktreeCatalog: vi.fn(),
      resolveWorktree: vi.fn(),
      ensureAgentSession: vi.fn(),
      resumeHolds: createRecoveryResumeHolds(),
      supportsClaudeAppendSystemPrompt: async () => false,
      activateWorktree: vi.fn()
    })
    const record = {
      paneKey: 'p',
      worktreeId: 'w',
      agent: 'claude' as const,
      providerSession: { key: 'session_id' as const, id: SESSION_ID },
      prompt: '',
      state: 'done' as const,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'recovery' as const,
      recovery: { importKey: 'k', sourcePaneKey: 's' }
    }
    await host.applyOp({ kind: 'merge-records', records: [record] })
    expect(stored.sleepingAgentSessionsByPaneKey).toEqual({ p: record })
    const claimed = await host.applyOp({
      kind: 'claim-record',
      worktreeId: 'w',
      binding: { agent: record.agent, ...record.providerSession }
    })
    expect(claimed).toEqual({ ok: true, claimed: record })
    expect(stored.sleepingAgentSessionsByPaneKey).toEqual({})
  })
})
