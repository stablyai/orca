import { describe, expect, it } from 'vitest'
import { isWslUserActFor, outsideWslUserAct, runAsWslUserAct } from './wsl-user-act-scope'

describe('WSL user act scope', () => {
  it('lets work inside the act start its own distro and no other', async () => {
    await runAsWslUserAct('Ubuntu', async () => {
      expect(isWslUserActFor('ubuntu')).toBe(true)
      await Promise.resolve()
      expect(isWslUserActFor('Ubuntu')).toBe(true)
      expect(isWslUserActFor('Debian')).toBe(false)
      expect(outsideWslUserAct(() => isWslUserActFor('Ubuntu'))).toBe(false)
    })
    expect(isWslUserActFor('Ubuntu')).toBe(false)
  })

  it('does not hand its allowance to a timer created inside it that fires after the act', async () => {
    let fireTimer!: () => void
    const firedLater = new Promise<boolean>((resolve) => {
      fireTimer = () => resolve(isWslUserActFor('Ubuntu'))
    })
    await runAsWslUserAct('Ubuntu', async () => {
      // e.g. a retry or poll armed during the act, keeping the act's async context.
      setTimeout(fireTimer, 5)
    })
    await expect(firedLater).resolves.toBe(false)
  })

  it('ends the allowance even when the act throws', async () => {
    let fireTimer!: () => void
    const firedLater = new Promise<boolean>((resolve) => {
      fireTimer = () => resolve(isWslUserActFor('Ubuntu'))
    })
    await expect(
      runAsWslUserAct('Ubuntu', async () => {
        setTimeout(fireTimer, 5)
        throw new Error('read failed')
      })
    ).rejects.toThrow('read failed')
    await expect(firedLater).resolves.toBe(false)
  })

  it('runs an act with no distro unscoped', async () => {
    await runAsWslUserAct(null, async () => {
      expect(isWslUserActFor('Ubuntu')).toBe(false)
    })
  })
})
