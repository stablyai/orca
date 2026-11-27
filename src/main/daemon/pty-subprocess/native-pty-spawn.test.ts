import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ptySpawn } = vi.hoisted(() => ({ ptySpawn: vi.fn() }))

vi.mock('node-pty', () => ({ spawn: ptySpawn }))
vi.mock('../../windows/windows-pty-job', () => ({ assignHostProcessToKillOnCloseJob: vi.fn() }))
vi.mock('@orca/process-host/wsl-distro-allowlist', () => ({ assertWslDistroAllowed: vi.fn() }))
vi.mock('../process-scopes/terminal-scopes-runtime', () => ({
  wrapPtySpawnInTerminalScope: (file: string, args: string[], env: Record<string, string>) => ({
    file,
    args,
    env
  })
}))
vi.mock('../../providers/shell-launch/macos/tcc-login-shell', () => ({
  hostReportsChildExitStatus: () => true,
  wrapShellSpawnForMacosTccAttribution: (file: string, args: string[]) => ({ file, args })
}))
vi.mock('./conpty-startup-input-reader', () => ({
  spawnConptyWithInputReader: (spawn: () => Promise<unknown>) => spawn()
}))
vi.mock('./daemon-pty-physical-owner', () => ({
  createDaemonPtyPhysicalOwner: () => ({
    completion: Promise.resolve(),
    exitCode: () => null,
    recover: async () => {},
    observeExit: () => {}
  })
}))

const originalPlatform = process.platform

describe('spawnNativeDaemonPty on Windows', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    vi.restoreAllMocks()
    ptySpawn.mockReset()
  })

  it('retries on the system ConPTY when the bundled one cannot launch (#47506)', async () => {
    const proc = { pid: 1 }
    ptySpawn.mockImplementation(
      (_file: string, _args: string[], opts: { useConptyDll: boolean }) => {
        if (opts.useConptyDll) {
          throw new Error(
            'Cannot launch conpty: ConptyCreatePseudoConsole failed with HRESULT 0x80070005'
          )
        }
        return proc
      }
    )
    const { spawnNativeDaemonPty } = await import('./native-pty-spawn')
    const spawned = await spawnNativeDaemonPty({
      shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      shellArgs: [],
      spawnCwd: 'C:\\Users\\user',
      env: {},
      cols: 80,
      rows: 24,
      windowsFallbackAttempts: []
    })
    expect(spawned.process).toBe(proc)
    expect(ptySpawn.mock.calls.map((call) => call[2].useConptyDll)).toEqual([true, false])
  })
})
