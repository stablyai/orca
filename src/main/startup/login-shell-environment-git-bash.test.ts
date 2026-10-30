import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: spawnProcessMock }))

import {
  resetLoginShellEnvironmentCacheForTests,
  resolveLoginShellEnvironment
} from './login-shell-environment'

const originalPlatform = process.platform

afterEach(() => {
  resetLoginShellEnvironmentCacheForTests()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

// #30946: Git Bash's own env holds /c/... PATH and TEMP=/tmp, which native agent spawns cannot use.
it('captures Git Bash env as a native Windows child sees it', async () => {
  Object.defineProperty(process, 'platform', { value: 'win32' })
  const nativeEnv = { Path: 'C:\\Users\\me\\npm-prefix;C:\\WINDOWS', TEMP: 'C:\\Users\\me\\Temp' }
  spawnProcessMock.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    })
    queueMicrotask(() => {
      child.stdout.write(
        `__ORCA_LOGIN_SHELL_ENV_START__${JSON.stringify(nativeEnv)}__ORCA_LOGIN_SHELL_ENV_END__`
      )
      child.emit('close', 0)
    })
    return child
  })

  const env = await resolveLoginShellEnvironment({
    shellOverride: 'C:\\Program Files\\Git\\bin\\bash.exe'
  })

  const [{ args }] = spawnProcessMock.mock.calls[0]
  expect(args[0]).toBe('-ilc')
  expect(args[1]).toMatch(/^powershell\.exe .*-EncodedCommand [A-Za-z0-9+/=]+$/)
  expect(env).toEqual(nativeEnv)
})
