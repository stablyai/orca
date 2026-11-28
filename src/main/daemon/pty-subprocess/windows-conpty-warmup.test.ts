import type * as pty from 'node-pty'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../../windows/windows-pty-job', () => ({
  assignHostProcessToKillOnCloseJob: vi.fn()
}))

import { warmWindowsConptyOnce } from './windows-conpty-warmup'

const originalPlatform = process.platform

function createFakePty(): pty.IPty {
  return {
    pid: 1234,
    cols: 2,
    rows: 1,
    process: 'cmd.exe',
    handleFlowControl: false,
    onData: () => ({ dispose: () => {} }),
    onExit: (listener) => {
      listener({ exitCode: 0 })
      return { dispose: () => {} }
    },
    resize: () => {},
    clear: () => {},
    write: () => {},
    kill: () => {},
    pause: () => {},
    resume: () => {}
  }
}

async function flushImmediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  vi.unstubAllEnvs()
})

it('spawns System32 cmd.exe when ComSpec is unset or blank', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('SystemRoot', 'D:\\Windows')
  vi.stubEnv('ComSpec', '   ')
  vi.stubEnv('COMSPEC', '   ')
  const spawnPty = vi.fn<typeof pty.spawn>(() => createFakePty())

  warmWindowsConptyOnce(spawnPty)
  await flushImmediate()

  expect(spawnPty).toHaveBeenCalledWith(
    'D:\\Windows\\System32\\cmd.exe',
    ['/c', 'exit'],
    expect.objectContaining({ useConptyDll: true })
  )
})

it('uses ComSpec when set', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  vi.stubEnv('ComSpec', 'E:\\Custom\\cmd.exe')
  const spawnPty = vi.fn<typeof pty.spawn>(() => createFakePty())

  warmWindowsConptyOnce(spawnPty)
  await flushImmediate()

  expect(spawnPty).toHaveBeenCalledWith('E:\\Custom\\cmd.exe', ['/c', 'exit'], expect.any(Object))
})
