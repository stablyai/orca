import { expect, it } from 'vitest'
import { resolveElectronProbeLaunch } from './electron-probe-display-launch'

it('a probe that shows its window on Linux gets its own Xvfb display even under a desktop session', () => {
  const launch = (privateDisplay: boolean) =>
    resolveElectronProbeLaunch({
      electronBinary: 'electron',
      electronArgs: ['main.cjs'],
      platform: 'linux',
      display: ':0',
      privateDisplay
    })
  expect(launch(true)).toEqual({
    executable: 'xvfb-run',
    args: ['--auto-servernum', 'electron', 'main.cjs', '--no-sandbox']
  })
  // Hidden-window probes keep sharing the inherited display.
  expect(launch(false)).toEqual({ executable: 'electron', args: ['main.cjs', '--no-sandbox'] })
})
