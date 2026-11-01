import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))
vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { grantCodexSandboxReadOnManagedHome } from './codex-windows-sandbox-read-grant'

const originalPlatform = process.platform
const originalComputerName = process.env.COMPUTERNAME
let home: string

function processResult(code: number, stdout = '') {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

function grantCalls(): string[] {
  return runProcessMock.mock.calls
    .map(([spec]) => spec.args)
    .filter((args: string[]) => args[1] === '/grant')
    .map((args: string[]) => args[0])
}

beforeEach(() => {
  runProcessMock.mockReset()
  runProcessMock.mockResolvedValue(processResult(0))
  home = mkdtempSync(join(tmpdir(), 'codex-sandbox-read-grant-'))
  mkdirSync(join(home, '.sandbox'))
  writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}')
  Object.defineProperty(process, 'platform', { value: 'win32' })
  process.env.COMPUTERNAME = 'PC'
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  process.env.COMPUTERNAME = originalComputerName
  vi.useRealTimers()
  rmSync(home, { recursive: true, force: true })
})

describe('grantCodexSandboxReadOnManagedHome', () => {
  it('grants the sandbox group read on the resource folders, never the home root', async () => {
    mkdirSync(join(home, 'skills'))

    await grantCodexSandboxReadOnManagedHome(home)
    await grantCodexSandboxReadOnManagedHome(home)

    expect(existsSync(join(home, 'generated_images'))).toBe(true)
    expect(grantCalls().sort()).toEqual([join(home, 'generated_images'), join(home, 'skills')])
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: expect.stringMatching(/System32[\\/]icacls\.exe$/),
        args: [join(home, 'skills'), '/grant', 'PC\\CodexSandboxUsers:(OI)(CI)RX', '/Q']
      })
    )
  })

  it('retries a failed grant on the next launch', async () => {
    runProcessMock.mockImplementation(async ({ args }) =>
      args[1] === '/grant' ? processResult(1332) : processResult(0)
    )
    await grantCodexSandboxReadOnManagedHome(home)
    runProcessMock.mockResolvedValue(processResult(0))
    await grantCodexSandboxReadOnManagedHome(home)

    expect(grantCalls()).toEqual([join(home, 'generated_images'), join(home, 'generated_images')])
  })

  it('does nothing before Codex set up its elevated sandbox for the home', async () => {
    rmSync(join(home, '.sandbox'), { recursive: true })
    await grantCodexSandboxReadOnManagedHome(home)
    expect(runProcessMock).not.toHaveBeenCalled()
  })
  it('skips linked skills and plugins so the grant never reaches the system Codex home', async () => {
    const systemHome = mkdtempSync(join(tmpdir(), 'codex-system-home-'))
    try {
      mkdirSync(join(systemHome, 'skills'))
      mkdirSync(join(systemHome, 'plugins'))
      symlinkSync(join(systemHome, 'skills'), join(home, 'skills'), 'junction')
      symlinkSync(join(systemHome, 'plugins'), join(home, 'plugins'), 'junction')

      await grantCodexSandboxReadOnManagedHome(home)

      expect(grantCalls()).toEqual([join(home, 'generated_images')])
    } finally {
      rmSync(systemHome, { recursive: true, force: true })
    }
  })

  it('grants once Codex writes its setup marker during the first elevated session', async () => {
    vi.useFakeTimers()
    rmSync(join(home, '.sandbox'), { recursive: true })
    writeFileSync(join(home, 'config.toml'), '[windows]\nsandbox = "elevated"\n')

    await grantCodexSandboxReadOnManagedHome(home)
    expect(runProcessMock).not.toHaveBeenCalled()

    mkdirSync(join(home, '.sandbox'))
    writeFileSync(join(home, '.sandbox', 'setup_marker.json'), '{}')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(grantCalls()).toEqual([join(home, 'generated_images')])
  })
})
