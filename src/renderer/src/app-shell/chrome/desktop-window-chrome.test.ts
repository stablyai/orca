import { expect, it } from 'vitest'
import { canUseLinuxTilingWindowMode, type DesktopWindowChromeInput } from './desktop-window-chrome'

it.each<[DesktopWindowChromeInput, boolean]>([
  [{ platform: 'linux', isWebClient: false }, true],
  [{ platform: 'linux', isWebClient: true }, false],
  [{ platform: 'win32', isWebClient: false }, false],
  [{ platform: 'darwin', isWebClient: false }, false]
])('resolves tiling mode availability for %j', (chrome, available) => {
  expect(canUseLinuxTilingWindowMode(chrome)).toBe(available)
})
