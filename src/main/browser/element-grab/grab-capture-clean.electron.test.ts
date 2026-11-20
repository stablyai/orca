import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runElectronFixture } from '../electron-fixtures/electron-fixture-run'

describe("Draw's capture after the picker turns off", () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it('holds no highlight or label pixels, from a running pick and a confirmed one, also on a busy page', async () => {
    const result = await runElectronFixture(
      join(import.meta.dirname, 'testing/grab-capture-clean-electron-fixture.ts')
    )
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    // Before teardown the capture shows the picker (so this check can see it); right after, none of it.
    const states = {
      overlayVisibleBefore: expect.toSatisfy((n: number) => n > 1000),
      offColourAfterTeardown: 0
    }
    expect(result.output).toEqual({
      pickedKinds: ['selected', 'selected'],
      'awaiting-idle': states,
      'confirming-idle': states,
      'awaiting-busy': states,
      'confirming-busy': states
    })
  }, 60_000)
})
