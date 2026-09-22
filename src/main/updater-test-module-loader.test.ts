import { setTimeout as sleep } from 'node:timers/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule } from './updater-test-module-loader'

// Why: this pair depends on running in file order — the first test starts an import it never awaits,
// standing in for a test whose `await loadUpdaterModule()` outran `testTimeout`, and the second test
// is the later test the continuation used to land in.
describe('updater module loader', () => {
  let outcome: Promise<string> = Promise.resolve('not started')

  afterAll(() => {
    vi.doUnmock('./updater')
    vi.resetModules()
  })

  it('starts an import that outlives the test that asked for it', () => {
    vi.resetModules()
    vi.doMock('./updater', async () => {
      await sleep(500)
      return { setupAutoUpdater: () => {} }
    })

    outcome = loadUpdaterModule().then(
      () => 'handed the module over',
      (error: Error) => error.message
    )
  })

  it('refuses to hand the module to a test that already ended', async () => {
    await expect(outcome).resolves.toContain('resolved after that test ended')
  })
})
