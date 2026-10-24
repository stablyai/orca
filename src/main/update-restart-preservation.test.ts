import { beforeEach, describe, expect, it, vi } from 'vitest'
const backup = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ app: { getPath: () => '/isolated-profile', getVersion: () => 'v1' } }))
vi.mock('./update-profile-snapshot', () => ({ createUpdateProfileSnapshot: backup }))
import { preserveStateBeforeUpdateRestart } from './update-restart-preservation'
beforeEach(() => {
  backup.mockReset()
})
describe('Required pre-update preservation', () => {
  it('flushes credentials and the authoritative checkpoint before snapshotting', async () => {
    const order: string[] = []
    backup.mockImplementation(async () => {
      order.push('backup')
    })
    await preserveStateBeforeUpdateRestart({
      codexRuntimeHome: {
        syncForCurrentSelection: () => {
          order.push('auth')
        },
        syncActiveWslSelectionsBeforeRestart: async () => {
          order.push('wsl')
        }
      },
      store: {
        flushPendingOrThrowAsync: async (options) => {
          expect(options).toEqual({ fullCheckpoint: true })
          order.push('checkpoint')
        }
      }
    })
    expect(order).toEqual(['auth', 'wsl', 'checkpoint', 'backup'])
    expect(backup).toHaveBeenCalledWith('/isolated-profile', 'v1')
  })
  it('propagates backup and credential failures so the installer cannot proceed', async () => {
    const store = { flushPendingOrThrowAsync: vi.fn().mockResolvedValue(undefined) }
    backup.mockRejectedValue(new Error('disk full'))
    await expect(
      preserveStateBeforeUpdateRestart({ codexRuntimeHome: null, store })
    ).rejects.toThrow('disk full')
    backup.mockClear()
    await expect(
      preserveStateBeforeUpdateRestart({
        codexRuntimeHome: {
          syncForCurrentSelection: () => {
            throw new Error('credential save failed')
          }
        },
        store
      })
    ).rejects.toThrow('credential save failed')
    expect(backup).not.toHaveBeenCalled()
  })
})
