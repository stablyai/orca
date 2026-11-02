import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const gateMocks = vi.hoisted(() => ({ readWslDistroRunningState: vi.fn() }))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  readWslDistroRunningState: gateMocks.readWslDistroRunningState
}))

const { traceWslGate, traceWslSpawn, WSL_SPAWN_TRACE_ENV } = await import('./wsl-spawn-trace')
const { runAsWslUserAct } = await import('./wsl-user-act-scope')
const { blockedWslDistroForPath } = await import('./wsl-unc-access-gate')

const WSL = 'C:\\WINDOWS\\System32\\wsl.exe'
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

describe('WSL spawn trace', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    warn.mockRestore()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  const lines = (): string[] => warn.mock.calls.map((call) => String(call[0]))

  it('logs nothing unless the env var turns it on', () => {
    traceWslSpawn('process-host', WSL, ['-d', 'Ubuntu', '--exec', 'true'])
    traceWslGate('path', 'Ubuntu', 'running read: stopped')
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs a wsl.exe start with its distro, argv, whether a user act covers it, and its callers', async () => {
    vi.stubEnv(WSL_SPAWN_TRACE_ENV, '1')

    traceWslSpawn('process-host', WSL, ['-d', 'Ubuntu', '--exec', 'sh', '-c', 'x'.repeat(400)])
    await runAsWslUserAct('Ubuntu', async () => {
      traceWslSpawn('git-runner', 'wsl.exe', ['-d', 'Ubuntu', 'git', 'status'])
    })
    traceWslSpawn('process-host', 'C:\\Program Files\\Git\\cmd\\git.exe', ['status'])

    const [first, second, ...rest] = lines()
    expect(first).toMatch(
      /^\[wsl-spawn-trace\] spawn process-host distro=Ubuntu userAct=false argv=/
    )
    expect(first).toContain('…')
    expect(first).not.toContain('x'.repeat(200))
    expect(first).toMatch(/ at \S/)
    expect(second).toContain('spawn git-runner distro=Ubuntu userAct=true')
    expect(rest).toEqual([])
    // Frames start at the caller of the trace, never at the trace helpers themselves.
    expect(first).not.toMatch(/ at (writeTrace|traceWslSpawn)\b/)
  })

  it("logs the path gate's verdict, by user act or by running read", async () => {
    vi.stubEnv(WSL_SPAWN_TRACE_ENV, '1')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    gateMocks.readWslDistroRunningState.mockResolvedValue('stopped')
    const path = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

    await blockedWslDistroForPath(path)
    await runAsWslUserAct('Ubuntu', () => blockedWslDistroForPath(path))

    expect(lines()).toEqual([
      expect.stringContaining('gate path distro=Ubuntu verdict=running read: stopped'),
      expect.stringContaining('gate path distro=Ubuntu verdict=admitted by user act')
    ])
  })
})
