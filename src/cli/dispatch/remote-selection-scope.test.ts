import { expect, it } from 'vitest'
import { ignoresRemoteSelection } from './remote-selection-scope'

it('sends agent ID commands to the selected host, and keeps hook setup on this machine', () => {
  expect(ignoresRemoteSelection(['agent', 'list'])).toBe(false)
  expect(ignoresRemoteSelection(['agent', 'show'])).toBe(false)
  expect(ignoresRemoteSelection(['agent', 'read'])).toBe(false)
  expect(ignoresRemoteSelection(['agent', 'launch'])).toBe(false)
  expect(ignoresRemoteSelection(['agent', 'hooks', 'status'])).toBe(true)
})
