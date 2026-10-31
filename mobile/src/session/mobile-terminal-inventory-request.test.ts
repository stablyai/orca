import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileTerminalInventoryRequest } from './mobile-terminal-inventory-request'

describe('MobileTerminalInventoryRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shares an in-flight request and upgrades its empty-list handling', async () => {
    const response = Promise.withResolvers<void>()
    const execute = vi.fn(async (allowsEmpty: () => boolean) => {
      await response.promise
      return allowsEmpty()
    })
    const requests = new MobileTerminalInventoryRequest()
    const startupStarted = vi.fn()
    const recoveryStarted = vi.fn()
    vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(200)

    const startup = requests.run(false, execute, startupStarted)
    const recovery = requests.run(true, execute, recoveryStarted)
    expect(recovery).toBe(startup)
    expect(startupStarted).toHaveBeenCalledExactlyOnceWith(100)
    expect(recoveryStarted).toHaveBeenCalledExactlyOnceWith(100)
    await Promise.resolve()
    expect(execute).toHaveBeenCalledTimes(1)

    response.resolve()
    await expect(startup).resolves.toBe(true)
    await expect(recovery).resolves.toBe(true)
  })

  it('starts fresh after the shared request settles or rejects', async () => {
    const requests = new MobileTerminalInventoryRequest()
    const failure = new Error('transport lost')

    await expect(
      requests.run(true, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    await expect(requests.run(true, async () => true)).resolves.toBe(true)
    await expect(requests.run(true, async () => false)).resolves.toBe(false)
  })

  it('fences a response after its route activation is replaced', async () => {
    const oldResponse = Promise.withResolvers<void>()
    const applied: string[] = []
    const requests = new MobileTerminalInventoryRequest()
    const deactivateOld = requests.activate()
    const oldResult = requests.run(true, async (_allowsEmpty, isCurrent) => {
      await oldResponse.promise
      if (!isCurrent()) {
        return false
      }
      applied.push('old')
      return true
    })
    await Promise.resolve()

    requests.activate()
    deactivateOld()
    oldResponse.resolve()
    await expect(oldResult).resolves.toBe(false)
    await expect(
      requests.run(true, async (_allowsEmpty, isCurrent) => {
        if (!isCurrent()) {
          return false
        }
        applied.push('next')
        return true
      })
    ).resolves.toBe(true)
    expect(applied).toEqual(['next'])
  })
})
