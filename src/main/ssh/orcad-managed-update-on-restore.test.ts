import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshTarget } from '../../shared/ssh-types'
import type { ManagedOrcadAutoUpdateOutcome } from './orcad-managed-auto-update'
import {
  redeployStoppedManagedOrcad,
  resetManagedOrcadRestoreUpdatesForTests,
  updateManagedOrcadOnRestore,
  type ManagedOrcadRestoreUpdateDeps
} from './orcad-managed-update-on-restore'

const target: SshTarget = { id: 'ssh-1', label: 'Box', host: 'box', port: 22, username: 'me' }

function deps(
  outcome: ManagedOrcadAutoUpdateOutcome,
  overrides: Partial<ManagedOrcadRestoreUpdateDeps> = {}
): ManagedOrcadRestoreUpdateDeps {
  return {
    target: () => target,
    publish: vi.fn(),
    autoUpdate: vi.fn(async (_id, options) => {
      if (outcome.outcome === 'updated' || outcome.outcome === 'failed') {
        options.onUpdating()
      }
      return outcome
    }),
    recordedUpdateFailure: () => null,
    recordUpdateFailure: vi.fn(),
    clearUpdateFailure: vi.fn(),
    ...overrides
  }
}

describe('updating a managed server when the launch restores its tunnel', () => {
  beforeEach(() => resetManagedOrcadRestoreUpdatesForTests())

  it('runs the same update check a connect runs, and publishes it', async () => {
    const d = deps({ outcome: 'updated', activeVersion: '0.1.0+b' })
    await updateManagedOrcadOnRestore('env-1', () => d)
    expect(d.autoUpdate).toHaveBeenCalledWith(
      'env-1',
      expect.objectContaining({ failedBefore: false })
    )
    expect(vi.mocked(d.publish).mock.calls).toEqual([
      [target, 'env-1', 'updating'],
      [target, 'env-1', 'settled', undefined]
    ])
  })

  it('checks each server once per session, however often its tunnel is ensured', async () => {
    const d = deps({ outcome: 'skipped', reason: 'current' })
    await updateManagedOrcadOnRestore('env-1', () => d)
    expect(updateManagedOrcadOnRestore('env-1', () => d)).toBeNull()
    expect(d.autoUpdate).toHaveBeenCalledTimes(1)
  })

  it('keeps the same safety: waits on terminals, never downgrades, records a failure', async () => {
    const waiting = deps({
      outcome: 'deferred',
      code: 'orcad_update_terminals_running',
      reason: 'r'
    })
    await updateManagedOrcadOnRestore('env-wait', () => waiting)
    expect(waiting.publish).toHaveBeenLastCalledWith(target, 'env-wait', 'settled', {
      state: 'deferred',
      detail: 'r'
    })

    const newer = deps({ outcome: 'skipped', reason: 'host-newer' })
    await updateManagedOrcadOnRestore('env-newer', () => newer)
    expect(newer.publish).toHaveBeenLastCalledWith(target, 'env-newer', 'settled', {
      state: 'host-newer'
    })

    const failed = deps({ outcome: 'failed', reason: 'rolled back' })
    await updateManagedOrcadOnRestore('env-failed', () => failed)
    expect(failed.recordUpdateFailure).toHaveBeenCalledWith(target, 'rolled back')

    const held = deps(
      { outcome: 'skipped', reason: 'failed-before' },
      { recordedUpdateFailure: () => 'rolled back' }
    )
    await updateManagedOrcadOnRestore('env-held', () => held)
    expect(held.autoUpdate).toHaveBeenCalledWith(
      'env-held',
      expect.objectContaining({ failedBefore: true })
    )
  })

  it('never fails the restore that triggered it', async () => {
    const thrown = deps(
      { outcome: 'skipped', reason: 'current' },
      {
        autoUpdate: async () => {
          throw new Error('ssh dropped')
        }
      }
    )
    await expect(updateManagedOrcadOnRestore('env-1', () => thrown)).resolves.toBeUndefined()
    expect(
      updateManagedOrcadOnRestore('env-2', () => {
        throw new Error('no SSH store')
      })
    ).toBeNull()
    const unlinked = deps({ outcome: 'skipped', reason: 'current' }, { target: () => null })
    expect(updateManagedOrcadOnRestore('env-3', () => unlinked)).toBeNull()
    expect(unlinked.autoUpdate).not.toHaveBeenCalled()
  })
})

describe('redeploying a server another desktop stopped mid-session', () => {
  beforeEach(() => resetManagedOrcadRestoreUpdatesForTests())

  it('runs even after this session already checked the server, and reports activation', async () => {
    await updateManagedOrcadOnRestore('env-1', () =>
      deps({ outcome: 'skipped', reason: 'current' })
    )
    const d = deps({ outcome: 'updated', activeVersion: '0.1.0+b' })
    await expect(redeployStoppedManagedOrcad('env-1', () => d)).resolves.toBe(true)
    expect(d.autoUpdate).toHaveBeenCalledWith('env-1', expect.anything())
    expect(vi.mocked(d.publish).mock.calls.at(-1)).toEqual([target, 'env-1', 'settled', undefined])
  })

  it('shares one attempt between concurrent calls and retries on the next one', async () => {
    const d = deps({ outcome: 'failed', reason: 'upload failed' })
    const [first, second] = await Promise.all([
      redeployStoppedManagedOrcad('env-1', () => d),
      redeployStoppedManagedOrcad('env-1', () => d)
    ])
    expect([first, second]).toEqual([false, false])
    expect(d.autoUpdate).toHaveBeenCalledTimes(1)
    await redeployStoppedManagedOrcad('env-1', () => d)
    expect(d.autoUpdate).toHaveBeenCalledTimes(2)
  })
})
