import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runElectronFixture } from '../electron-fixtures/electron-fixture-run'

describe('tool letters from a real page during a pick', () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it('leaves typing to page fields (also in shadow roots) and takes letters only off them', async () => {
    const result = await runElectronFixture(
      join(import.meta.dirname, 'testing/grab-page-keys-electron-fixture.ts')
    )
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    const output: unknown = result.output
    const holdMs = output && typeof output === 'object' && 'holdMs' in output ? output.holdMs : null
    process.stdout.write(
      `idle field-query round-trip (not end-to-end input latency): ${JSON.stringify(holdMs)}\n`
    )
    expect(result.output).toEqual({
      focusAfterArm: 'search',
      editableAtArm: true,
      searchValue: 'cd',
      forwardedWhileInField: [],
      trackerVisibleToPage: false,
      tabThenLetter: { focused: 'host', forwarded: [] },
      scriptFocusThenLetter: { value: 'sa', forwarded: [] },
      noteValue: 'g',
      editableOnButton: false,
      forwardedOnButton: ['a'],
      pageSawToolKey: false,
      altEdges: ['alt-down', 'alt-up'],
      // With the picker off nothing is known about the page: unknown counts as a field.
      editableAfterOff: true,
      // Recorded query samples are diagnostic; wall-clock latency is not a correctness assertion.
      holdMs: {
        count: expect.any(Number),
        median: expect.any(Number),
        max: expect.any(Number)
      }
    })
  }, 60_000)
})
