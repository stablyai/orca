import { beforeEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const { lstatSync, existsSync } = vi.hoisted(() => ({
  lstatSync: vi.fn(),
  existsSync: vi.fn((..._args: unknown[]) => false)
}))
vi.mock('node:fs', () => ({ lstatSync, existsSync }))
vi.mock('node:os', () => ({ homedir: () => '/home/me' }))
import {
  canSkipAgentBrowserSessionReset,
  resolveAgentBrowserSocketDirectory,
  waitForAgentBrowserSessionExit
} from './agent-browser-session-reset'

const owned = {
  ownsSocketDirectory: true,
  socketDirectory: '/tmp/orca-ab-profile',
  sessionName: 'orca-tab-page'
}
const socketPath = join(owned.socketDirectory, 'orca-tab-page.sock')

beforeEach(() => {
  lstatSync.mockReset()
  existsSync.mockReset()
  existsSync.mockReturnValue(false)
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

it('resolves the socket directory the way agent-browser does', () => {
  expect(resolveAgentBrowserSocketDirectory({ AGENT_BROWSER_SOCKET_DIR: '/tmp/ab' })).toBe(
    '/tmp/ab'
  )
  expect(
    resolveAgentBrowserSocketDirectory({ AGENT_BROWSER_SOCKET_DIR: '', XDG_RUNTIME_DIR: '/run/u' })
  ).toBe(join('/run/u', 'agent-browser'))
  expect(resolveAgentBrowserSocketDirectory({})).toBe(join('/home/me', '.agent-browser'))
})

it('waits until the closing daemon removes its pid file', async () => {
  let checks = 0
  existsSync.mockImplementation(() => ++checks <= 2)
  const exited = await waitForAgentBrowserSessionExit({
    env: { AGENT_BROWSER_SOCKET_DIR: '/tmp/ab' },
    sessionName: 'orca-tab-page',
    deadline: Date.now() + 1_000
  })
  expect(exited).toBe(true)
  expect(checks).toBe(3)
  expect(existsSync).toHaveBeenCalledWith(join('/tmp/ab', 'orca-tab-page.pid'))
})

it('gives up at the deadline while the daemon is still alive', async () => {
  existsSync.mockReturnValue(true)
  const exited = await waitForAgentBrowserSessionExit({
    env: { AGENT_BROWSER_SOCKET_DIR: '/tmp/ab' },
    sessionName: 'orca-tab-page',
    deadline: Date.now() + 60
  })
  expect(exited).toBe(false)
})

it('never builds a pid path from an unsafe session name', async () => {
  existsSync.mockReturnValue(true)
  expect(
    await waitForAgentBrowserSessionExit({ env: {}, sessionName: '../x', deadline: Date.now() })
  ).toBe(true)
  expect(existsSync).not.toHaveBeenCalled()
})
