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
vi.mock('./distro-catalog', () => ({
  listWslDistrosAsync,
  getCachedWslDistros: () => cachedList.current
}))
vi.mock('./wsl-background-distro-gate', () => ({
  readWslDistroRunningState,
  noteWslDistroWoken: vi.fn(),
  noteWslDistrosRunning: vi.fn(),
  noteWslDistroMayHaveStopped: vi.fn()
}))

import { runAsWslExecUserAct } from './wsl-background-exec-gate'
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
})
