import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, readWslDistroRunningState } = vi.hoisted(() => ({
  runProcess: vi.fn(),
  readWslDistroRunningState: vi.fn()
}))

vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../wsl-background-distro-gate', () => ({
  readWslDistroRunningState,
  noteWslDistroWoken: vi.fn(),
  noteWslDistrosRunning: vi.fn(),
  noteWslDistroMayHaveStopped: vi.fn()
}))

import {
  assertWslDistroRunningForExec,
  blockedWslDistroForExec,
  runAsWslExecUserAct
} from './wsl-background-exec-gate'

const UBUNTU_ID = '0e3a7f2c-1b4d-4c5e-9f60-7a8b9c0d1e2f'
const DEBIAN_ID = '1f4b8a3d-2c5e-4d6f-8a71-8b9c0d1e2f30'
const LXSS = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'

function lxss(defaultId: string | null, distros: [string, string][]): string {
  return [
    LXSS,
    ...(defaultId ? [`    DefaultDistribution    REG_SZ    {${defaultId}}`] : []),
    '',
    ...distros.flatMap(([id, name]) => [
      `${LXSS}\\{${id}}`,
      `    DistributionName    REG_SZ    ${name}`,
      '    Version    REG_DWORD    0x2',
      ''
    ])
  ].join('\r\n')
}

describe('blockedWslDistroForExec', () => {
  const platform = process.platform

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    runProcess.mockReset()
    readWslDistroRunningState.mockReset().mockResolvedValue('running')
  })
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
  })

  it('refuses an unnamed run when the default distro cannot be read', async () => {
    runProcess.mockResolvedValue({ code: 1, stdout: '' })
    await expect(blockedWslDistroForExec(null)).resolves.toEqual({
      distro: 'the default distro',
      state: 'unverifiable'
    })
    await expect(assertWslDistroRunningForExec(undefined)).rejects.toMatchObject({
      code: 'WSL_DISTRO_UNVERIFIABLE'
    })
    expect(readWslDistroRunningState).not.toHaveBeenCalled()
  })

  it('refuses when the registry read throws or names no registered default', async () => {
    runProcess.mockRejectedValueOnce(new Error('timed out'))
    await expect(blockedWslDistroForExec(null)).resolves.toMatchObject({ state: 'unverifiable' })
    runProcess.mockResolvedValueOnce({ code: 0, stdout: lxss(null, [[UBUNTU_ID, 'Ubuntu']]) })
    await expect(blockedWslDistroForExec(null)).resolves.toMatchObject({ state: 'unverifiable' })
  })

  it('gates the current default, read fresh after a set-default', async () => {
    const both: [string, string][] = [
      [UBUNTU_ID, 'Ubuntu'],
      [DEBIAN_ID, 'Debian']
    ]
    readWslDistroRunningState.mockImplementation(async (distro: string) =>
      distro === 'Debian' ? 'stopped' : 'running'
    )
    runProcess.mockResolvedValueOnce({ code: 0, stdout: lxss(UBUNTU_ID, both) })
    await expect(blockedWslDistroForExec(null)).resolves.toBeNull()
    runProcess.mockResolvedValueOnce({ code: 0, stdout: lxss(DEBIAN_ID, both) })
    await expect(blockedWslDistroForExec(null)).resolves.toEqual({
      distro: 'Debian',
      state: 'stopped'
    })
  })

  it('allows an unnamed run when no distro is registered: wsl.exe has nothing to start', async () => {
    runProcess.mockResolvedValue({ code: 0, stdout: lxss(null, []) })
    await expect(blockedWslDistroForExec(null)).resolves.toBeNull()
  })

  it('a named distro skips the registry read', async () => {
    readWslDistroRunningState.mockResolvedValue('stopped')
    await expect(blockedWslDistroForExec(' Ubuntu ')).resolves.toEqual({
      distro: 'Ubuntu',
      state: 'stopped'
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('a user act on an unresolved default passes inside the act only', async () => {
    runProcess.mockResolvedValue({ code: 1, stdout: '' })
    await expect(runAsWslExecUserAct(null, () => blockedWslDistroForExec(null))).resolves.toBeNull()
    await expect(blockedWslDistroForExec(null)).resolves.toMatchObject({ state: 'unverifiable' })
  })

  it('never reads the registry off Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await expect(blockedWslDistroForExec(null)).resolves.toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })
})
