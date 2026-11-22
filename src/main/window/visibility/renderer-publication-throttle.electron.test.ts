import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runElectronFixture } from '../../browser/electron-fixtures/electron-fixture-run'

describe('publication lease release during Electron guest destruction', () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it('closes streamed guests without terminating the host', async () => {
    const result = await runElectronFixture(
      join(import.meta.dirname, '../testing/renderer-publication-throttle-electron-fixture.ts')
    )
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.output).toEqual({
      frames: expect.toSatisfy((frames: number) => frames >= 3),
      releasesDuringDestruction: 3,
      restoreCalls: 0,
      captureCalls: 0,
      title: 'Host is still reachable'
    })
  }, 60_000)
})
