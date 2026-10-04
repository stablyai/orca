import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  resolveReasonixExecutionHostConfig,
  resolveReasonixExecutionHostRoots
} from './execution-host-config'

const environment = vi.hoisted(() => vi.fn())
vi.mock('../startup/login-shell-environment', () => ({
  resolveLoginShellEnvironment: environment
}))

beforeEach(() => environment.mockReset())
afterEach(() => vi.unstubAllEnvs())

it('reads the owning host login-shell root rather than an inherited client root', async () => {
  vi.stubEnv('REASONIX_HOME', join(homedir(), 'client-root'))
  const hostRoot = join(homedir(), 'host-root')
  environment.mockResolvedValue({ REASONIX_HOME: hostRoot })
  await expect(resolveReasonixExecutionHostConfig()).resolves.toBe(hostRoot)
})

it('uses Orca absolute-root policy when a native override depends on an unknown launch cwd', async () => {
  environment.mockResolvedValue({ REASONIX_HOME: '../relative' })
  await expect(resolveReasonixExecutionHostConfig()).resolves.toBe(
    process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Roaming', 'reasonix')
      : join(homedir(), '.reasonix')
  )
})

it('keeps source-owned history storage separate from the configuration and inherited client root', async () => {
  vi.stubEnv('REASONIX_STATE_HOME', join(homedir(), 'client-state'))
  const configHome = join(homedir(), 'host-config')
  const stateHome = join(homedir(), 'host-history')
  environment.mockResolvedValue({ REASONIX_HOME: configHome, REASONIX_STATE_HOME: stateHome })
  await expect(resolveReasonixExecutionHostRoots()).resolves.toEqual({ configHome, stateHome })
})

it('does not probe an already aborted request', async () => {
  const controller = new AbortController()
  controller.abort()
  await expect(resolveReasonixExecutionHostConfig(controller.signal)).rejects.toMatchObject({
    name: 'AbortError'
  })
  expect(environment).not.toHaveBeenCalled()
})

it('rejects cancellation after shell resolution before an installer can start', async () => {
  const controller = new AbortController()
  environment.mockImplementation(async () => {
    controller.abort()
    return { REASONIX_HOME: join(homedir(), 'host-root') }
  })
  await expect(resolveReasonixExecutionHostConfig(controller.signal)).rejects.toMatchObject({
    name: 'AbortError'
  })
})
