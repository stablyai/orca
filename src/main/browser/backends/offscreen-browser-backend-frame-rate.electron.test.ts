import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runElectronFixture } from '../electron-fixtures/electron-fixture-run'

describe('offscreen browser page frame rate', () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it('ticks unwatched pages slowly and leased pages at full rate', async () => {
    const result = await runElectronFixture(
      join(import.meta.dirname, 'testing/offscreen-page-frame-rate-electron-fixture.ts')
    )
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    // Two seconds at 5 fps draws about 10 frames and at 60 fps about 120.
    const fewFrames = expect.toSatisfy((frames: number) => frames <= 15)
    expect(result.output).toEqual({
      unwatched: fewFrames,
      swappedProcess: true,
      unwatchedAfterSiteSwap: fewFrames,
      watched: expect.any(Number),
      watchedOutpacesUnwatched: true,
      visibility: 'visible'
    })
  }, 60_000)
})
