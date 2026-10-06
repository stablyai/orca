import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { TerminalHost } from './terminal-host'
import type { TerminalHostOptions } from './terminal-host-options'
import { buildLaunchFilePointer, carryInLaunchFile } from '../../shared/launch-prompt-file'
import type { WslLaunchDirectory } from '../../shared/wsl-launch-directory'

vi.mock('../pty-descendant-termination', () => ({ killWithDescendantSweep: vi.fn() }))

describe('a daemon WSL session with a launch file', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  let host: TerminalHost
  let spawn: Mock<TerminalHostOptions['spawnSubprocess']>
  let windowsSide: string

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    // Stands in for the distro's `\\wsl.localhost` cache directory.
    windowsSide = mkdtempSync(join(tmpdir(), 'orca-daemon-wsl-test-'))
    spawn = vi.fn<TerminalHostOptions['spawnSubprocess']>(() =>
      Object.assign(createMockSubprocess(), { shellPath: 'C:\\Windows\\System32\\wsl.exe' })
    )
    host = new TerminalHost({ spawnSubprocess: spawn })
  })

  afterEach(async () => {
    Object.defineProperty(process, 'platform', platform)
    await host.dispose()
    rmSync(windowsSide, { recursive: true, force: true })
  })

  function create(wslLaunchDirectory: WslLaunchDirectory | undefined) {
    const { prompt, launchFile } = carryInLaunchFile('secret brief')
    return host.createOrAttach({
      sessionId: 'wsl-session',
      cols: 80,
      rows: 24,
      command: `claude '${prompt}'`,
      launchFile,
      launchAgent: 'claude',
      shellOverride: 'wsl.exe',
      terminalWindowsWslDistro: 'Ubuntu',
      ...(wslLaunchDirectory ? { wslLaunchDirectory } : {}),
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
  }

  it('writes the file into the distro and types its Linux path', async () => {
    await create({ distro: 'Ubuntu', windowsPath: windowsSide, linuxPath: '/home/ada/.cache/orca' })
    const command = spawn.mock.calls[0]?.[0].command ?? ''
    const linuxPath = /\/home\/ada\/\.cache\/orca\/orca-launch-file-\d+-\w+\/task-context\.md/.exec(
      command
    )?.[0]
    expect(command).toBe(`claude '${buildLaunchFilePointer(linuxPath ?? 'missing')}'`)
    const written = join(windowsSide, linuxPath!.split('/').at(-2)!, 'task-context.md')
    expect(readFileSync(written, 'utf8')).toBe('secret brief')
  })

  it('refuses the spawn when main could not reach the distro home', async () => {
    await expect(create(undefined)).rejects.toThrow(/could not be reached/)
    expect(spawn).not.toHaveBeenCalled()
    expect(readdirSync(windowsSide)).toEqual([])
  })
})
