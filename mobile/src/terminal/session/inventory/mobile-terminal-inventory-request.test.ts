import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileTerminalInventoryRequest } from './mobile-terminal-inventory-request'

describe('MobileTerminalInventoryRequest', () => {
  afterEach(() => {
    vi.restoreAllMocks()
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
