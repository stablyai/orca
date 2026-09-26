import { describe, expect, it, vi } from 'vitest'
import { recoveryBindingKeyString } from '../../../shared/cross-machine-recovery-binding-key'
import { importRecoveryWorkspaceWithHost } from './recovery-import'
import { descriptor, fixture, SESSION_ID } from './recovery-import.test-fixture'
import { releaseRecoveryBindingWithHost } from './recovery-release'
import { resumeRecoveryBindingWithHost } from './recovery-resume'

describe('releaseRecoveryBindingWithHost', () => {
  it('claims the dormant record and records the binding as consumed without launching', async () => {
    const f = fixture()
    await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )
    const binding = { agent: 'claude' as const, key: 'session_id' as const, id: SESSION_ID }

    const result = await releaseRecoveryBindingWithHost(f.host, f.worktreeId, binding)

    expect(result.released).toMatchObject({ agent: 'claude', id: SESSION_ID })
    expect(Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(0)
    expect(f.host.getWorktreeMeta(f.worktreeId)?.recoveryProvenance?.consumedBindings).toEqual([
      recoveryBindingKeyString(result.released)
    ])
    expect(f.ensureAgentSession).not.toHaveBeenCalled()
    await expect(releaseRecoveryBindingWithHost(f.host, f.worktreeId, binding)).rejects.toThrow(
      'recovery_binding_not_found'
    )
  })

  it('keeps the binding dormant and resumable when recording the release fails', async () => {
    const f = fixture()
    await importRecoveryWorkspaceWithHost(
      f.host,
      { descriptor: descriptor(), checkoutPath: f.checkout, checkpointId: 'cp' },
      f.readCommonDir
    )
    const write = f.host.updateRecoveryProvenance
    f.host.updateRecoveryProvenance = vi.fn(write).mockRejectedValueOnce(new Error('write failed'))
    const binding = { agent: 'claude' as const, key: 'session_id' as const, id: SESSION_ID }

    await expect(releaseRecoveryBindingWithHost(f.host, f.worktreeId, binding)).rejects.toThrow(
      'write failed'
    )

    expect(Object.values(f.getSession().sleepingAgentSessionsByPaneKey ?? {})).toHaveLength(1)
    await expect(
      resumeRecoveryBindingWithHost(f.host, { worktree: `id:${f.worktreeId}`, binding: SESSION_ID })
    ).resolves.toMatchObject({ disposition: 'created' })
  })
})
