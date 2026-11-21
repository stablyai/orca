import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runElectronFixture } from '../electron-fixtures/electron-fixture-run'

describe('freeing idle offscreen browser pages', () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it('frees an idle saved page and wakes it under the same id with its history', async () => {
    const result = await runElectronFixture(
      join(import.meta.dirname, 'testing/offscreen-page-free-electron-fixture.ts')
    )
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.output).toEqual({
      unsavedKept: true,
      savedFreed: true,
      wokenUrl: '/second',
      wokenHistoryLength: 2,
      backUrl: '/first'
    })
  }, 60_000)
})
