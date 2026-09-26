import { describe, expect, it, vi } from 'vitest'
import { recoveryBindingKeyString } from '../../../shared/cross-machine-recovery-binding-key'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { resumeRecoveryBindingWithHost } from './recovery-resume'
import { binding, descriptor, fixture, SESSION_ID } from './recovery-import.test-fixture'

const OTHER_SESSION_ID = '6a2d2d4f-2222-4333-8444-555566667777'
const BINDING = { agent: 'claude' as const, key: 'session_id' as const, id: SESSION_ID }

describe('recovery import replay', () => {
  it('finishes an import that crashed between the layout apply and the provenance write', async () => {
    const f = fixture()
    const writeProvenance = f.host.updateRecoveryProvenance
    f.host.updateRecoveryProvenance = vi
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
    const writeProvenance = f.host.updateRecoveryProvenance
    f.host.updateRecoveryProvenance = vi
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

  it('reports the pane key the merge kept when concurrent replays add one binding', async () => {
    const f = fixture()
    const request = { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp-1' }
    await importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)
    const added = {
      ...binding(),
      providerSession: { key: 'session_id' as const, id: OTHER_SESSION_ID }
    }
    const grown = { ...request, descriptor: { ...descriptor(), bindings: [binding(), added] } }
    const apply = f.host.applyOp
    let arrivals = 0
    let openGate = (): void => {}
    const gate = new Promise<void>((resolve) => {
      openGate = resolve
    })
    f.host.applyOp = async (op) => {
      if (op.kind === 'merge-records') {
        arrivals += 1
        // Why: opens on the second replay's merge, or shortly after the first when imports serialize.
        setTimeout(openGate, arrivals === 2 ? 0 : 50)
        await gate
      }
      return await apply(op)
    }

    const replays = await Promise.all([
      importRecoveryWorkspaceWithHost(f.host, grown, f.readCommonDir),
      importRecoveryWorkspaceWithHost(f.host, grown, f.readCommonDir)
    ])

    const stored = Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {}).filter(
      (record) => record.providerSession.id === OTHER_SESSION_ID
    )
    expect(stored).toHaveLength(1)
    expect(
      replays.map((r) => r.bindings.find((b) => b.binding.id === OTHER_SESSION_ID)?.localPaneKey)
    ).toEqual([stored[0]!.paneKey, stored[0]!.paneKey])
  })

  it('replays the second of two concurrent identical first imports', async () => {
    const f = fixture()
    const apply = f.host.applyOp
    f.host.applyOp = async (op) => {
      await new Promise((resolve) => setTimeout(resolve, 10))
      return await apply(op)
    }
    const request = {
      descriptor: { ...descriptor(), bindings: [] },
      checkoutPath: f.checkout,
      checkpointId: 'cp-1'
    }

    const results = await Promise.all([
      importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir),
      importRecoveryWorkspaceWithHost(f.host, request, f.readCommonDir)
    ])

    expect(results.map((r) => r.disposition).sort()).toEqual(['imported', 'replayed'])
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
