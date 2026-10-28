import { describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGateModule from '../wsl-background-distro-gate'

const mocks = vi.hoisted(() => ({ noteWslDistroWoken: vi.fn() }))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGateModule>()),
  noteWslDistroWoken: mocks.noteWslDistroWoken
}))

import { runAsWslUserAct } from './wsl-unc-access-gate'
import { isWslUserActFor } from './wsl-user-act-scope'

describe('runAsWslUserAct marks the distro woken when the act settles', () => {
  it.each([
    ['succeeds', async () => 'read'],
    [
      'throws',
      async () => {
        throw new Error('read failed')
      }
    ]
  ])('when the act %s, before its allowance ends', async (_case, act) => {
    mocks.noteWslDistroWoken.mockReset()
    let allowanceAtNote: boolean | null = null
    mocks.noteWslDistroWoken.mockImplementation(() => {
      allowanceAtNote = isWslUserActFor('Ubuntu')
    })
    await runAsWslUserAct('Ubuntu', act).catch(() => undefined)
    // A follow-up must not be answered by a "stopped" read taken before the act.
    expect(mocks.noteWslDistroWoken).toHaveBeenCalledExactlyOnceWith('Ubuntu')
    expect(allowanceAtNote).toBe(true)
  })

  it('notes nothing for an act with no distro', async () => {
    mocks.noteWslDistroWoken.mockReset()
    await runAsWslUserAct(null, async () => undefined)
    expect(mocks.noteWslDistroWoken).not.toHaveBeenCalled()
  })
})
