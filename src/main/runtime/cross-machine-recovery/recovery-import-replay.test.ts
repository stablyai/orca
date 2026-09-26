import { describe, expect, it, vi } from 'vitest'
import { recoveryBindingKeyString } from '../../../shared/cross-machine-recovery-binding-key'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { resumeRecoveryBindingWithHost } from './recovery-resume'
import { descriptor, fixture, SESSION_ID } from './recovery-import.test-fixture'

const BINDING = { agent: 'claude' as const, key: 'session_id' as const, id: SESSION_ID }

describe('recovery import replay', () => {
  it('finishes an import that crashed between the layout apply and the provenance write', async () => {
    const f = fixture()
    const writeProvenance = f.host.setRecoveryProvenance
    f.host.setRecoveryProvenance = vi
      .fn(writeProvenance)
      .mockRejectedValueOnce(new Error('crashed before provenance'))
    const request = { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp-1' }
    await expect(importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)).rejects.toThrow(
      'crashed before provenance'
    )
    const appliedTabs = f.getSession().tabsByWorktree[f.worktreeId]

    const retry = await importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)

    expect(retry.disposition).toBe('replayed')
    expect(retry.bindings).toEqual([expect.objectContaining({ status: 'dormant' })])
    expect(f.host.getWorktreeMeta(f.worktreeId)?.recoveryProvenance).toMatchObject({
      importKey: retry.importKey,
      checkpointId: 'cp-1'
    })
    expect(f.getSession().tabsByWorktree[f.worktreeId]).toEqual(appliedTabs)
    expect(Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(1)
    expect(f.ensureAgentSession).not.toHaveBeenCalled()
  })

  it('still refuses a crashed import whose destination also holds a foreign record', async () => {
    const f = fixture()
    const writeProvenance = f.host.setRecoveryProvenance
    f.host.setRecoveryProvenance = vi
      .fn(writeProvenance)
      .mockRejectedValueOnce(new Error('crashed before provenance'))
    const request = { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp-1' }
    await expect(
      importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)
    ).rejects.toThrow()
    const other = { ...descriptor(), source: { ...descriptor().source, runtimeId: 'other-host' } }

    await expect(
      importRecoveryWorkspaceWithHost(f.host, { ...request, descriptor: other }, f.readCommonDir)
    ).rejects.toThrow('recovery_destination_not_empty')
  })

  it('never re-adds a binding resumed before its session is observed live', async () => {
    const f = fixture({ live: false })
    const request = { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp-1' }
    await importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)
    await resumeRecoveryBindingWithHost(f.host, {
      worktree: `id:${f.worktreeId}`,
      binding: SESSION_ID
    })
    expect(f.host.resumeHolds.isHeld(BINDING)).toBe(false)

    const replay = await importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)

    expect(replay.bindings[0]).toMatchObject({
      status: 'refused',
      reason: 'recovery_binding_consumed'
    })
    expect(f.getSession().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(f.host.getWorktreeMeta(f.worktreeId)?.recoveryProvenance?.consumedBindings).toEqual([
      recoveryBindingKeyString(BINDING)
    ])
  })
})
