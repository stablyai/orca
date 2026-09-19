import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as Fs from 'node:fs'
import type * as ChildProcess from 'node:child_process'

const { readlink, exec } = vi.hoisted(() => ({ readlink: vi.fn(), exec: vi.fn() }))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof Fs>()),
  readlinkSync: readlink
}))
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof ChildProcess>()),
  execFile: exec
}))
import { probeProcessCwd, resolveProcessCwd } from './pty-shell-utils'

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  vi.resetAllMocks()
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  readlink.mockImplementation(() => {
    throw new Error('unreadable')
  })
  exec.mockImplementation((_command, _args, _options, callback) =>
    callback(new Error('unreadable'))
  )
})
afterEach(() => Object.defineProperty(process, 'platform', platform))

it('returns the measured cwd without a subprocess when procfs answers', async () => {
  readlink.mockReturnValue('/srv/current')
  await expect(probeProcessCwd(123)).resolves.toBe('/srv/current')
  expect(readlink).toHaveBeenCalledWith('/proc/123/cwd')
  expect(exec).not.toHaveBeenCalled()
})

it('uses only the requested pid cwd from lsof', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
  exec.mockImplementation((_command, _args, _options, callback) =>
    callback(null, { stdout: 'p123\nn/srv/current\n', stderr: '' })
  )
  await expect(probeProcessCwd(123)).resolves.toBe('/srv/current')
  expect(exec).toHaveBeenCalledWith(
    'lsof',
    ['-a', '-p', '123', '-d', 'cwd', '-Fn'],
    expect.objectContaining({ timeout: 3000 }),
    expect.any(Function)
  )
})

it('keeps unavailable measurement separate from the legacy fallback', async () => {
  await expect(probeProcessCwd(123)).resolves.toBeNull()
  await expect(resolveProcessCwd(123, '/srv/initial')).resolves.toBe('/srv/initial')
})

it('does not execute POSIX probes on Windows', async () => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  await expect(probeProcessCwd(123)).resolves.toBeNull()
  expect(readlink).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
})

it.each([0, -1, Number.NaN, 1.5])('refuses invalid pid %s without probing', async (pid) => {
  await expect(probeProcessCwd(pid)).resolves.toBeNull()
  expect(readlink).not.toHaveBeenCalled()
  expect(exec).not.toHaveBeenCalled()
})
