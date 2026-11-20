import { mkdirSync, rmSync } from 'node:fs'
import {
  buildPopupIdentityProbe,
  createPopupIdentityProbeRoot
} from '../electron-fixtures/popup-identity-electron-probe'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runElectronFixture } from '../electron-fixtures/electron-fixture-run'

const preloadRoot = createPopupIdentityProbeRoot()
afterAll(() => rmSync(preloadRoot, { recursive: true, force: true }))

describe("Draw's capture after the picker turns off", () => {
  // Builds a fixture bundle and launches real Electron, which is slow on CI runners.
  it('holds no highlight or label pixels, from a running pick and a confirmed one, also on a busy page', async () => {
    mkdirSync(join(preloadRoot, 'home'), { recursive: true })
    await buildPopupIdentityProbe(
      preloadRoot,
      join(process.cwd(), 'src/preload/browser-guest.ts'),
      'browser-guest-preload.cjs'
    )
    const result = await runElectronFixture(
      join(import.meta.dirname, 'testing/grab-capture-clean-electron-fixture.ts'),
      {
        ORCA_BROWSER_GUEST_PRELOAD: join(preloadRoot, 'browser-guest-preload.cjs'),
        HOME: join(preloadRoot, 'home'),
        XDG_CONFIG_HOME: join(preloadRoot, 'home', 'config')
      },
      { isolatedEnvironment: true }
    )
    for (const line of result.stderr
      .split('\n')
      .filter((line) => line.startsWith('[palette-proof]'))) {
      process.stdout.write(`${line}\n`)
    }
    expect(result.timedOut).toBe(false)
    expect(result.code, `${result.signal}\n${result.stdout}\n${result.stderr}`).toBe(0)
    // Before teardown the capture shows the picker (so this check can see it); right after, none of it.
    const states = {
      overlayVisibleBefore: expect.toSatisfy((n: number) => n > 1000),
      offColourAfterTeardown: 0
    }
    expect(result.output).toEqual({
      pickedKinds: ['selected', 'selected'],
      recovery: {
        loadingObserved: true,
        slowLoadFinished: true,
        cancelledLoad: null,
        obsoleteCodeAbsent: true,
        processLoss: null,
        recovered: true
      },
      'awaiting-idle': states,
      'confirming-idle': states,
      'awaiting-busy': states,
      'confirming-busy': states
    })
  }, 60_000)
})
