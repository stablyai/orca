import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const { lstatSync } = vi.hoisted(() => ({ lstatSync: vi.fn() }))
vi.mock('node:fs', () => ({ lstatSync }))
import { canSkipAgentBrowserSessionReset } from './agent-browser-session-reset'

const owned = {
  ownsSocketDirectory: true,
  socketDirectory: '/tmp/orca-ab-profile',
  sessionName: 'orca-tab-page'
}
const socketPath = join(owned.socketDirectory, 'orca-tab-page.sock')

beforeEach(() => {
  lstatSync.mockReset()
})

it('skips an absent owned socket', () => {
  lstatSync.mockImplementation(() => {
    throw Object.assign(new Error('No socket'), { code: 'ENOENT' })
  })
  expect(canSkipAgentBrowserSessionReset(owned)).toBe(true)
  expect(lstatSync).toHaveBeenCalledWith(socketPath)
})

it('requires reset when a socket or symlink exists', () => {
  lstatSync.mockReturnValue({})
  expect(canSkipAgentBrowserSessionReset(owned)).toBe(false)
  expect(lstatSync).toHaveBeenCalledWith(socketPath)
})

it.each(['EACCES', 'EIO', 'ENOTDIR'])('requires reset for %s', (code) => {
  lstatSync.mockImplementation(() => {
    throw Object.assign(new Error('Socket inspection failed'), { code })
  })
  expect(canSkipAgentBrowserSessionReset(owned)).toBe(false)
  expect(lstatSync).toHaveBeenCalledWith(socketPath)
})

// Windows and inherited socket directories both arrive as ownsSocketDirectory: false.
it.each([
  { ownsSocketDirectory: false },
  { socketDirectory: undefined },
  { sessionName: '../other' },
  { sessionName: 'has space' },
  { sessionName: '' }
])('requires reset without an owned Unix socket address: %j', (override) => {
  expect(canSkipAgentBrowserSessionReset({ ...owned, ...override })).toBe(false)
  expect(lstatSync).not.toHaveBeenCalled()
})
