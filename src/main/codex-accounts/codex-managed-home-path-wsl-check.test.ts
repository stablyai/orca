import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { WslResult, WslSpec } from '../wsl/wsl-runner'

const runWslProcess = vi.hoisted(() => vi.fn<(spec: WslSpec) => Promise<WslResult>>())
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess }))
vi.mock('../wsl', () => ({
  toWindowsWslPath: (linuxPath: string, distro: string) =>
    `\\\\wsl.localhost\\${distro}${linuxPath}`
}))

import { CodexManagedHomePath } from './codex-managed-home-path'

const LINUX_HOME = '/home/alice/.local/share/orca/codex-accounts/acct/home'
const UNC_HOME = String.raw`\\wsl.localhost\Ubuntu\home\alice\.local\share\orca\codex-accounts\acct\home`
const originalPlatform = process.platform

/** What a guest whose rc files print a banner would send back around the fenced payload. */
function answer(spec: WslSpec, payload: string, code = 0): WslResult {
  const script = String(spec.script)
  const begin = /printf %s (__ORCA_WSL_CAPTURE_BEGIN_) (\S+__)/.exec(script)
  const end = /printf %s (__ORCA_WSL_CAPTURE_END_) (\S+__)/.exec(script)
  const fenced = begin && end ? `${begin[1]}${begin[2]}${payload}\n${end[1]}${end[2]}` : payload
  return {
    environmentResolved: true,
    code,
    stdout: `Welcome to Ubuntu\nnvm 0.40\n${fenced}`,
    stderr: '',
    timedOut: false
  }
}

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  runWslProcess.mockReset()
})

it('reads only the fenced path, off the main thread and without the login shell', async () => {
  runWslProcess.mockImplementation(async (spec) => answer(spec, LINUX_HOME))
  await expect(new CodexManagedHomePath().assert(UNC_HOME, 'acct')).resolves.toBe(
    `\\\\wsl.localhost\\Ubuntu${LINUX_HOME}`
  )
  expect(runWslProcess).toHaveBeenCalledWith(
    expect.objectContaining({ distro: 'Ubuntu', loginPath: 'none', shell: 'bash' })
  )
})

it('refuses a home whose check failed in the distro', async () => {
  runWslProcess.mockImplementation(async (spec) => answer(spec, '', 35))
  await expect(new CodexManagedHomePath().assert(UNC_HOME, 'acct')).rejects.toThrow(
    'Managed WSL Codex home is outside Orca account storage.'
  )
})

it('refuses a home whose check printed no fence', async () => {
  runWslProcess.mockResolvedValue({
    environmentResolved: true,
    code: 0,
    stdout: `${LINUX_HOME}\n`,
    stderr: '',
    timedOut: false
  })
  await expect(new CodexManagedHomePath().assert(UNC_HOME, 'acct')).rejects.toThrow(
    'Managed WSL Codex home is outside Orca account storage.'
  )
})
