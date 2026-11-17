import { expect, it } from 'vitest'
import { projectPluginPanelIcon } from './plugin-list-projection'

it('uses the plug icon for unrecognized format 1 panel icons', () => {
  expect(projectPluginPanelIcon(undefined, 1, 'acme.panel', null, 0)).toBe('plug')
  expect(projectPluginPanelIcon('x.svg', 1, 'acme.panel', null, 0)).toBe('plug')
  expect(projectPluginPanelIcon('databse', 1, 'acme.panel', null, 0)).toBe('plug')
})
