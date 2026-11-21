import type * as NodeChildProcess from 'node:child_process'
import { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof NodeChildProcess>('node:child_process')
  return { ...actual, spawn: spawnMock }
})

import { spawnProxyCommand } from './ssh-proxy-command'

const originalPlatform = process.platform

function createFakeChild(): ChildProcess {
  const child = new ChildProcess()
  Object.defineProperties(child, {
    stdin: { value: new PassThrough(), configurable: true },
    stdout: { value: new PassThrough(), configurable: true },
    stderr: { value: new PassThrough(), configurable: true }
  })
  return child
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
  spawnMock.mockReset()
})

it('spawns System32 cmd.exe for Windows ProxyCommand when ComSpec is unset or blank', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  vi.stubEnv('ComSpec', '   ')
  vi.stubEnv('COMSPEC', '   ')
  spawnMock.mockImplementationOnce(() => createFakeChild())

  const handle = spawnProxyCommand(
    { kind: 'proxy-command', command: 'nc %h %p' },
    'example.com',
    22,
    'alice'
  )
  handle.sock.destroy()

  expect(spawnMock).toHaveBeenCalledWith(
    'D:\\Windows\\System32\\cmd.exe',
    ['/d', '/s', '/c', '"nc "example.com" "22""'],
    expect.objectContaining({ windowsHide: true, windowsVerbatimArguments: true })
  )
})

it('uses ComSpec for Windows ProxyCommand when set', () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('ComSpec', 'E:\\Custom\\cmd.exe')
  spawnMock.mockImplementationOnce(() => createFakeChild())

  const handle = spawnProxyCommand(
    { kind: 'proxy-command', command: 'nc %h %p' },
    'example.com',
    22,
    'alice'
  )
  handle.sock.destroy()

  expect(spawnMock).toHaveBeenCalledWith(
    'E:\\Custom\\cmd.exe',
    expect.any(Array),
    expect.any(Object)
  )
})
