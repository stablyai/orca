import { afterEach, describe, expect, it } from 'vitest'
import {
  resetCodexHookTransactionQueueForTests,
  runCodexHookTransaction
} from './codex-hook-transaction-queue'

afterEach(() => {
  resetCodexHookTransactionQueueForTests()
})

describe('Codex hook transaction queue', () => {
  it('serializes concurrent launches and an immediate disable after install', async () => {
    const operations: string[] = []
    let releaseInstall: (() => void) | undefined
    const install = runCodexHookTransaction(async () => {
      operations.push('install:start')
      await new Promise<void>((resolve) => {
        releaseInstall = resolve
      })
      operations.push('install:end')
    })
    const secondLaunch = runCodexHookTransaction(() => {
      operations.push('launch:second')
    })
    const disable = runCodexHookTransaction(() => {
      operations.push('disable:remove')
    })

    await Promise.resolve()
    expect(operations).toEqual(['install:start'])
    releaseInstall?.()
    await Promise.all([install, secondLaunch, disable])

    expect(operations).toEqual(['install:start', 'install:end', 'launch:second', 'disable:remove'])
  })

  it('continues after a failed transaction', async () => {
    await expect(
      runCodexHookTransaction(() => {
        throw new Error('write failed')
      })
    ).rejects.toThrow('write failed')
    await expect(runCodexHookTransaction(() => 'recovered')).resolves.toBe('recovered')
  })
})
