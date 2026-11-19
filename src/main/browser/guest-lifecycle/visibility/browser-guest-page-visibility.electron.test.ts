import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runElectronFixture } from '../../electron-fixtures/electron-fixture-run'

describe('browser guest page visibility in real Electron webviews', () => {
  it('reports a tab that is not shown as hidden, and the shown tab as visible', async () => {
    const result = await runElectronFixture(
      join(import.meta.dirname, 'browser-guest-page-visibility-electron-fixture.ts')
    )
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.output).toEqual({
      loaded: {
        first: { visibilityState: 'visible', hidden: false },
        second: { visibilityState: 'hidden', hidden: true }
      },
      // Electron sends every guest 'visible' when the window is restored; a background tab must not flash.
      windowShown: { first: 0, second: 0 },
      switched: {
        first: { visibilityState: 'hidden', hidden: true, lastEvent: 'hidden' },
        second: { visibilityState: 'visible', hidden: false, lastEvent: 'visible' }
      },
      reloadedInBackground: { visibilityState: 'hidden', hidden: true }
    })
  }, 60_000)
})
