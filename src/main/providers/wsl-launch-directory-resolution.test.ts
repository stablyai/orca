import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalPtyLaunchPlan, resolveLocalPtyWslDistro } from './local-pty-launch-plan'
import type { LocalPtyProviderOptions } from './local-pty-provider-types'
import type { PtySpawnOptions } from './types'
import {
  noteWslLaunchDirectoryRefusal,
  wslLaunchDirectoryKnownBroken,
  resolveSpawnWslLaunchDirectory,
  resolveWslLaunchDirectory,
  WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS
} from './wsl-launch-directory-resolution'
import type * as WslModule from '../wsl'

const { runWslProcess } = vi.hoisted(() => ({ runWslProcess: vi.fn() }))
vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof WslModule>()),
  getDefaultWslDistro: () => 'Debian'
}))
vi.mock('../wsl/wsl-runner', () => ({ runWslProcess }))
vi.mock('./local-pty-utils', () => ({
  ensureNodePtySpawnHelperExecutable: vi.fn(),
  validateWorkingDirectory: vi.fn()
}))

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform)
  vi.clearAllMocks()
})

function answers(stdout: string, code = 0) {
  return { environmentResolved: true, code, stdout, stderr: '', timedOut: false }
}

describe('resolveWslLaunchDirectory', () => {
  it("names a cache directory in the distro's home both ways, with the pane's login shell", async () => {
    runWslProcess.mockResolvedValue(answers('/home/ada\n/usr/bin/zsh\n'))
    await expect(resolveWslLaunchDirectory('Ubuntu')).resolves.toEqual({
      distro: 'Ubuntu',
      windowsPath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cache\\orca',
      linuxPath: '/home/ada/.cache/orca',
      shell: '/usr/bin/zsh'
    })
    expect(runWslProcess).toHaveBeenCalledWith(
      expect.objectContaining({ distro: 'Ubuntu', loginPath: 'none', shell: 'sh' })
    )
  })

  // Why: files written over the UNC share take 9P's default mode, so only the directory's mode
  // keeps a launch file's prompt from the distro's other users.
  it('makes the cache directory private to the distro user before anything is written there', async () => {
    runWslProcess.mockResolvedValue(answers('/home/ada\n/bin/bash\n'))
    await resolveWslLaunchDirectory('Kali')
    expect(runWslProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        script: expect.stringContaining(
          `_orca_root="$HOME"/'.cache/orca'\nmkdir -p "$_orca_root" && chmod 700 "$_orca_root" || exit 1`
        )
      })
    )
  })

  it('probes a distro once, and remembers a failure only for its TTL', async () => {
    vi.useFakeTimers()
    try {
      runWslProcess.mockResolvedValueOnce(answers('', 1))
      await expect(resolveWslLaunchDirectory('Arch')).resolves.toBeUndefined()
      runWslProcess.mockResolvedValue(answers('/home/ada\n/bin/bash\n'))
      // Why: a broken distro must not cost every spawn a wsl.exe round trip.
      await expect(resolveWslLaunchDirectory('Arch')).resolves.toBeUndefined()
      expect(runWslProcess).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS)
      await expect(resolveWslLaunchDirectory('Arch')).resolves.toMatchObject({
        shell: '/bin/bash'
      })
      await resolveWslLaunchDirectory('Arch')
      expect(runWslProcess).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  // Why (stack QA P8-2): a folder found once and broken later must not be written into forever,
  // and the next launch is planned without it until the distro is asked again.
  it('counts a folder broken after a refused write, then asks the distro again', async () => {
    vi.useFakeTimers()
    try {
      runWslProcess.mockResolvedValue(answers('/home/ada\n/bin/bash\n'))
      const found = await resolveWslLaunchDirectory('Void')
      noteWslLaunchDirectoryRefusal(found, new Error('EACCES'))
      expect(wslLaunchDirectoryKnownBroken('Void')).toBe(false)
      noteWslLaunchDirectoryRefusal(
        found,
        new Error(
          'Orca could not write it (EEXIST), so the agent was not started. [launch_file_unavailable]'
        )
      )
      expect(wslLaunchDirectoryKnownBroken('Void')).toBe(true)
      await expect(resolveWslLaunchDirectory('Void')).resolves.toBeUndefined()
      expect(runWslProcess).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(WSL_LAUNCH_DIRECTORY_FAILURE_TTL_MS)
      expect(wslLaunchDirectoryKnownBroken('Void')).toBe(false)
      await expect(resolveWslLaunchDirectory('Void')).resolves.toMatchObject({ distro: 'Void' })
      expect(runWslProcess).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts a distro whose probe failed broken, for planning', async () => {
    runWslProcess.mockResolvedValue(answers('', 1))
    await resolveWslLaunchDirectory('Mint')
    await Promise.resolve()
    expect(wslLaunchDirectoryKnownBroken('Mint')).toBe(true)
  })

  it('probes only for a spawn that needs the directory', async () => {
    runWslProcess.mockResolvedValue(answers('/home/ada\n/bin/bash\n'))
    expect(
      resolveSpawnWslLaunchDirectory('Gentoo', { command: 'claude', launchAgent: 'claude' })
    ).toBeUndefined()
    expect(
      resolveSpawnWslLaunchDirectory(undefined, { command: 'x'.repeat(600), launchAgent: 'claude' })
    ).toBeUndefined()
    await expect(
      resolveSpawnWslLaunchDirectory('Gentoo', {
        command: `claude '${'x'.repeat(600)}'`,
        launchAgent: 'claude'
      })
    ).resolves.toMatchObject({ distro: 'Gentoo' })
    expect(runWslProcess).toHaveBeenCalledTimes(1)
  })

  it('has none for a spawn outside WSL or a distro whose home cannot be read', async () => {
    await expect(resolveWslLaunchDirectory(undefined)).resolves.toBeUndefined()
    runWslProcess.mockResolvedValue(answers('not-a-path\n'))
    await expect(resolveWslLaunchDirectory('Alpine')).resolves.toBeUndefined()
    runWslProcess.mockRejectedValue(new Error('wsl.exe missing'))
    await expect(resolveWslLaunchDirectory('Fedora')).resolves.toBeUndefined()
  })
})

describe('resolveLocalPtyWslDistro', () => {
  // Why: the launch file goes into this distro, so it must be the one the plan starts.
  it.each<[string, Partial<PtySpawnOptions>, string]>([
    ['a WSL worktree path', { cwd: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo' }, 'Ubuntu'],
    [
      'a WSL worktree id',
      { cwd: 'C:\\work', worktreeId: 'repo::\\\\wsl.localhost\\Arch\\home\\ada\\repo' },
      'Arch'
    ],
    [
      'a WSL tab with a chosen distro',
      { cwd: 'C:\\work', shellOverride: 'wsl.exe', terminalWindowsWslDistro: 'Alpine' },
      'Alpine'
    ],
    ['a WSL tab on the default distro', { cwd: 'C:\\work', shellOverride: 'wsl.exe' }, 'Debian'],
    ['WSL as the default shell', { cwd: 'C:\\work' }, 'Debian']
  ])('agrees with the launch plan for %s', (_label, spawn, distro) => {
    const args = { cols: 80, rows: 24, ...spawn }
    const getOptions = (): LocalPtyProviderOptions => ({ getWindowsShell: () => 'wsl.exe' })
    expect(resolveLocalPtyWslDistro(args, getOptions)).toBe(distro)
    const plan = createLocalPtyLaunchPlan(args, getOptions)
    expect('launchWslDistro' in plan && plan.launchWslDistro).toBe(distro)
  })

  it('has none for a PowerShell tab', () => {
    const getOptions = (): LocalPtyProviderOptions => ({ getWindowsShell: () => 'powershell.exe' })
    expect(resolveLocalPtyWslDistro({ cols: 80, rows: 24, cwd: 'C:\\work' }, getOptions)).toBe(
      undefined
    )
  })
})
