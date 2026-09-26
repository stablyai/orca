import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  directory: vi.fn(),
  identity: vi.fn(),
  daemonOwns: vi.fn()
}))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.run }))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: () => 'C:\\Orca' }))
vi.mock('./wsl-managed-cli', () => ({
  getManagedWslCliDir: mocks.directory,
  getWslCliCommandName: () => 'orca-dev'
}))
vi.mock('../pty/wsl-orca-env', () => ({
  addOrcaWslInteropEnv: (env: Record<string, string>) => {
    env.WSLENV = 'ORCA_WSL_CLI_DIR/p'
  }
}))
vi.mock('../wsl/wsl-executable-path', () => ({ resolveWslExecutablePath: () => 'wsl.exe' }))
vi.mock('../daemon/daemon-provider-state', () => ({
  getDaemonProvider: () => ({}),
  daemonOwnsFreshPersistentPtys: mocks.daemonOwns
}))
vi.mock('../daemon/daemon-provider-routing', () => ({
  getCurrentDaemonAdapter: () => ({ getDaemonIdentity: mocks.identity })
}))
import { isManagedWslCliAvailable } from './wsl-managed-cli-availability'

function readyOutput(args: string[]): string {
  const script = args.at(-1) ?? ''
  return `distro banner\n${script.match(/__ORCA_WSL_CAPTURE_BEGIN_\w+__/)?.[0]}managed-cli-ready${script.match(/__ORCA_WSL_CAPTURE_END_\w+__/)?.[0]}`
}

beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  mocks.daemonOwns.mockReturnValue(true)
  mocks.identity.mockReturnValue({ managedWslCli: true })
  mocks.directory.mockReturnValue('C:\\Orca\\managed')
  mocks.run.mockImplementation(async ({ args }: { args: string[] }) => ({
    code: 0,
    stdout: readyOutput(args)
  }))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})

describe('managed WSL CLI availability', () => {
  it.each([null, {}, { managedWslCli: false }])(
    'keeps registration for an unconfirmed daemon: %j',
    async (identity) => {
      mocks.identity.mockReturnValue(identity)
      expect(await isManagedWslCliAvailable('Ubuntu')).toBe(false)
      expect(mocks.run).not.toHaveBeenCalled()
    }
  )

  it('probes the selected distro through the managed bridge and ignores its banner', async () => {
    expect(await isManagedWslCliAvailable(' Ubuntu ')).toBe(true)
    expect(mocks.run).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['-d', 'Ubuntu', '--exec', 'sh', '-c', expect.any(String)],
        env: expect.objectContaining({
          ORCA_WSL_CLI_DIR: 'C:\\Orca\\managed',
          ORCA_CLI_COMMAND: 'orca-dev'
        })
      })
    )
  })

  it('checks local spawning when no daemon owns fresh terminals', async () => {
    mocks.daemonOwns.mockReturnValue(false)
    mocks.identity.mockReturnValue(null)
    expect(await isManagedWslCliAvailable()).toBe(true)
  })

  it('keeps registration when provisioning, the shell, or bridge cannot be confirmed', async () => {
    mocks.directory.mockReturnValueOnce(null)
    expect(await isManagedWslCliAvailable()).toBe(false)
    mocks.run.mockResolvedValueOnce({ code: 1, stdout: '' })
    expect(await isManagedWslCliAvailable()).toBe(false)
    mocks.run.mockResolvedValueOnce({ code: 0, stdout: 'managed-cli-ready' })
    expect(await isManagedWslCliAvailable()).toBe(false)
  })

  it('coalesces concurrent reads per distro but rechecks after a daemon change', async () => {
    await Promise.all([
      isManagedWslCliAvailable('Ubuntu'),
      isManagedWslCliAvailable('Ubuntu'),
      isManagedWslCliAvailable('Debian')
    ])
    expect(mocks.run).toHaveBeenCalledTimes(2)
    mocks.identity.mockReturnValue({})
    expect(await isManagedWslCliAvailable('Ubuntu')).toBe(false)
    expect(mocks.run).toHaveBeenCalledTimes(2)
  })

  it('never probes WSL on a non-Windows execution host', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    expect(await isManagedWslCliAvailable()).toBe(false)
    expect(mocks.directory).not.toHaveBeenCalled()
    expect(mocks.run).not.toHaveBeenCalled()
  })
})
