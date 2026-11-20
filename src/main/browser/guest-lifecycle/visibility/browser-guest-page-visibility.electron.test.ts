import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runElectronFixture } from '../../electron-fixtures/electron-fixture-run'
import {
  buildPopupIdentityProbe,
  createPopupIdentityProbeRoot
} from '../../electron-fixtures/popup-identity-electron-probe'

const preloadRoot = createPopupIdentityProbeRoot()
afterAll(() => rmSync(preloadRoot, { recursive: true, force: true }))

describe('browser guest page visibility in real Electron webviews', () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it('reports a tab that is not shown as hidden, and the shown tab as visible', async () => {
    await buildPopupIdentityProbe(
      preloadRoot,
      join(process.cwd(), 'src/preload/browser-guest.ts'),
      'browser-guest-preload.cjs'
    )
    const result = await runElectronFixture(
      join(import.meta.dirname, 'browser-guest-page-visibility-electron-fixture.ts'),
      { ORCA_BROWSER_GUEST_PRELOAD: join(preloadRoot, 'browser-guest-preload.cjs') }
    )
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    // Per frame (the top document, then the first tab's iframe): [visibilityState, hidden, last event].
    expect(result.output).toEqual({
      // A document can start in the right state, so loading may fire no event.
      loaded: {
        first: [
          ['visible', false, expect.toBeOneOf([null, 'visible'])],
          ['visible', false, expect.toBeOneOf([null, 'visible'])]
        ],
        second: [['hidden', true, expect.toBeOneOf([null, 'hidden'])]]
      },
      // Electron sends every guest 'visible' when the window is restored; a background tab must not flash.
      backgroundEventsOnRestore: [0],
      windowHidden: 'hidden',
      windowRestored: 'visible',
      switched: {
        first: [
          ['hidden', true, 'hidden'],
          ['hidden', true, 'hidden']
        ],
        second: [['visible', false, 'visible']]
      },
      reloadedInBackground: [
        ['hidden', true, expect.toBeOneOf([null, 'hidden'])],
        ['hidden', true, expect.toBeOneOf([null, 'hidden'])]
      ]
    })
  }, 60_000)
})
