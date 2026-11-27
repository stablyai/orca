import { expect, it } from 'vitest'
import { projectPluginPanelIcon } from './plugin-list-projection'

it('keeps names in icon and sends path icons, defaults applied, in iconPath', () => {
  expect(projectPluginPanelIcon(undefined)).toEqual({})
  expect(projectPluginPanelIcon('database')).toEqual({ icon: 'database' })
  expect(projectPluginPanelIcon({ path: 'M4 4h16v16H4z' })).toEqual({
    iconPath: { path: 'M4 4h16v16H4z', viewBox: '0 0 24 24', mode: 'stroke' }
  })
  expect(projectPluginPanelIcon({ path: 'M0 0h8', viewBox: '0 0 8 8', mode: 'fill' })).toEqual({
    iconPath: { path: 'M0 0h8', viewBox: '0 0 8 8', mode: 'fill' }
  })
  // Why: Chromium would draw nothing for these, so the panel keeps `puzzle`.
  expect(projectPluginPanelIcon({ path: 'M1. 2.L-.5-1.5' })).toEqual({})
  expect(projectPluginPanelIcon({ path: 'M0 0L1e39 1' })).toEqual({})
})
