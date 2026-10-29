import { describe, expect, it, vi } from 'vitest'
import type { OrcadInstanceLock } from '../orcad/orcad-instance-lock'
import { OrcadInstanceLockError } from '../orcad/orcad-data-root-privacy'
import { acquireDesktopProfileInstanceLock } from './desktop-profile-instance-lock'

describe('the desktop share of the profile instance lock', () => {
  it('takes the lock as the desktop', () => {
    const lock: OrcadInstanceLock = Object.assign(Object.create(null), { release: vi.fn() })
    const acquire = vi.fn(() => lock)
    expect(acquireDesktopProfileInstanceLock('/profile', acquire)).toEqual({
      state: 'acquired',
      lock
    })
    expect(acquire).toHaveBeenCalledWith('/profile', { role: 'desktop' })
  })

  // #32177: a holder this machine cannot judge (a shared home) may be running, so it is held too.
  it.each(['orcad_instance_lock_held', 'orcad_instance_lock_holder_unverifiable'] as const)(
    'refuses while an orcad may serve the profile (%s), and says so',
    (code) => {
      const write = vi.fn()
      const result = acquireDesktopProfileInstanceLock(
        '/profile',
        () => {
          throw new OrcadInstanceLockError(code, 'Another orcad (pid 7) ...')
        },
        write
      )
      expect(result).toEqual({
        state: 'held',
        message: 'Another orcad (pid 7) ...'
      })
      expect(write).toHaveBeenCalledWith(2, '[single-instance] Another orcad (pid 7) ...\n')
    }
  )

  it('still starts when the lock cannot be taken for any other reason', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(
      acquireDesktopProfileInstanceLock('/profile', () => {
        throw new OrcadInstanceLockError('orcad_instance_lock_unreadable', 'unreadable')
      })
    ).toEqual({ state: 'unavailable' })
  })
})
