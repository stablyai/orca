import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcess, readWslDistroRunningState, listWslDistrosAsync, cachedList } = vi.hoisted(
  () => {
    const list: { current: string[] | null } = { current: null }
    return {
      runProcess: vi.fn(),
      readWslDistroRunningState: vi.fn(),
      listWslDistrosAsync: vi.fn(),
      cachedList: list
    }
  }
)

vi.mock('@orca/process-host', () => ({ runProcess }))
vi.mock('../wsl', () => ({
  listWslDistrosAsync,
  getCachedWslDistros: () => cachedList.current
}))
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
import { resetWslDefaultDistroForTests, resolveWslDefaultDistro } from './wsl-default-distro'

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
    // wsl.exe's list fails too unless a test says otherwise.
    listWslDistrosAsync.mockReset().mockResolvedValue([])
    cachedList.current = null
    resetWslDefaultDistroForTests()
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
    resetWslDefaultDistroForTests()
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
    // A list read that saw the change invalidates the short-lived default.
    cachedList.current = ['Debian', 'Ubuntu']
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

  it('names the default from wsl --list when only the registry is blocked', async () => {
    runProcess.mockResolvedValue({ code: 1, stdout: '' })
    listWslDistrosAsync.mockResolvedValue(['Ubuntu', 'Debian'])
    readWslDistroRunningState.mockResolvedValue('stopped')
    await expect(blockedWslDistroForExec(null)).resolves.toEqual({
      distro: 'Ubuntu',
      state: 'stopped'
    })
  })

  it('a user act and every gate inside it agree on one default, even if the registry flips', async () => {
    // The registry answers once, then is blocked (policy, timeout); wsl.exe still lists distros.
    runProcess.mockResolvedValueOnce({
      code: 0,
      stdout: lxss(DEBIAN_ID, [
        [UBUNTU_ID, 'Ubuntu'],
        [DEBIAN_ID, 'Debian']
      ])
    })
    runProcess.mockResolvedValue({ code: 1, stdout: '' })
    listWslDistrosAsync.mockResolvedValue(['Ubuntu'])
    readWslDistroRunningState.mockResolvedValue('stopped')
    const inside = await runAsWslExecUserAct(null, async () => {
      resetWslDefaultDistroForTests()
      // The hook relay names the default itself, then gates it by name.
      const named = await resolveWslDefaultDistro()
      return {
        named,
        relayGate: await blockedWslDistroForExec(typeof named === 'string' ? named : null)
      }
    })
    expect(inside).toEqual({ named: 'Debian', relayGate: null })
  })

  it('work an unnamed act left behind reads the default fresh once the act settles', async () => {
    const both: [string, string][] = [
      [UBUNTU_ID, 'Ubuntu'],
      [DEBIAN_ID, 'Debian']
    ]
    runProcess.mockResolvedValue({ code: 0, stdout: lxss(DEBIAN_ID, both) })
    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    let later: Promise<unknown> = Promise.resolve()
    const seenInside = await runAsWslExecUserAct(null, async () => {
      // A continuation queued inside keeps the act's async context, pin included.
      later = held.then(() => resolveWslDefaultDistro())
      return resolveWslDefaultDistro()
    })
    expect(seenInside).toBe('Debian')
    // `wsl --set-default Ubuntu` after the act settled.
    runProcess.mockResolvedValue({ code: 0, stdout: lxss(UBUNTU_ID, both) })
    resetWslDefaultDistroForTests()
    release()
    await expect(later).resolves.toBe('Ubuntu')
  })

  it('shares one registry read across a burst of unnamed checks within its TTL', async () => {
    runProcess.mockResolvedValue({ code: 0, stdout: lxss(UBUNTU_ID, [[UBUNTU_ID, 'Ubuntu']]) })
    await Promise.all([1, 2, 3].map(() => blockedWslDistroForExec(null)))
    await blockedWslDistroForExec(undefined)
    expect(runProcess).toHaveBeenCalledTimes(1)
    const now = performance.now()
    vi.spyOn(performance, 'now').mockReturnValue(now + 6_000)
    await blockedWslDistroForExec(null)
    expect(runProcess).toHaveBeenCalledTimes(2)
    vi.restoreAllMocks()
  })

  it('never reads the registry off Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    await expect(blockedWslDistroForExec(null)).resolves.toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })
})
