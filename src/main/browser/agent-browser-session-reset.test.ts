import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const { lstatSync } = vi.hoisted(() => ({ lstatSync: vi.fn() }))
vi.mock('node:fs', () => ({ lstatSync }))
import { canSkipAgentBrowserSessionReset } from './agent-browser-session-reset'

const owned = {
  platform: 'darwin' as const,
  ownsSocketDirectory: true,
  socketDirectory: '/tmp/orca-ab-profile',
  sessionName: 'orca-tab-page'
}

beforeEach(() => {
  lstatSync.mockReset()
})

it.each(['darwin', 'linux'] as const)('skips an absent owned socket on %s', (platform) => {
  lstatSync.mockImplementation(() => {
    throw Object.assign(new Error('No socket'), { code: 'ENOENT' })
  })
  expect(canSkipAgentBrowserSessionReset({ ...owned, platform })).toBe(true)
  expect(lstatSync).toHaveBeenCalledWith(join(owned.socketDirectory, 'orca-tab-page.sock'))
})

it('requires reset when a socket or symlink exists', () => {
  lstatSync.mockReturnValue({})
  expect(canSkipAgentBrowserSessionReset(owned)).toBe(false)
})

it.each(['EACCES', 'EIO', 'ENOTDIR'])('requires reset for %s', (code) => {
  lstatSync.mockImplementation(() => {
    throw Object.assign(new Error('Socket inspection failed'), { code })
  })
  expect(canSkipAgentBrowserSessionReset(owned)).toBe(false)
})

it.each([
  { platform: 'win32' as const },
  { ownsSocketDirectory: false },
  { socketDirectory: undefined },
  { socketDirectory: 'relative' },
  { sessionName: '../other' },
  { sessionName: '' }
])('requires reset without an owned Unix socket address: %j', (override) => {
  expect(canSkipAgentBrowserSessionReset({ ...owned, ...override })).toBe(false)
  expect(lstatSync).not.toHaveBeenCalled()
})
