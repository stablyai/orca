import { mkdirSync, rmSync } from 'node:fs'
import {
  buildPopupIdentityProbe,
  createPopupIdentityProbeRoot
} from '../electron-fixtures/popup-identity-electron-probe'
import { join } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { runElectronFixture } from '../electron-fixtures/electron-fixture-run'

const preloadRoot = createPopupIdentityProbeRoot()
afterAll(() => rmSync(preloadRoot, { recursive: true, force: true }))

// Builds a fixture bundle and launches real Electron, which is slow on CI runners.
it('a serve page picks through the offscreen preload, also after a re-arm during an outstanding wait', async () => {
  mkdirSync(join(preloadRoot, 'home'), { recursive: true })
  await buildPopupIdentityProbe(
    preloadRoot,
    join(process.cwd(), 'src/preload/browser-offscreen-page.ts'),
    'browser-offscreen-preload.cjs'
  )
  const result = await runElectronFixture(
    join(import.meta.dirname, 'testing/grab-offscreen-page-electron-fixture.ts'),
    {
      ORCA_BROWSER_OFFSCREEN_PRELOAD: join(preloadRoot, 'browser-offscreen-preload.cjs'),
      HOME: join(preloadRoot, 'home'),
      XDG_CONFIG_HOME: join(preloadRoot, 'home', 'config')
    },
    { isolatedEnvironment: true }
  )
  expect(result.timedOut).toBe(false)
  expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
  expect(result.output).toEqual({
    firstArm: true,
    replacementArm: true,
    firstWait: 'cancelled',
    pick: { kind: 'selected', target: 'button' }
  })
}, 60_000)
