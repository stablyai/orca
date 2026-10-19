import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProcessResult, ProcessSpec } from '@orca/process-host/process-spec'

const mocks = vi.hoisted(() => ({
  runProcess: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  probeCodexSharedServer: vi.fn<(home: string) => Promise<'live' | 'absent' | 'unknown'>>()
}))
vi.mock('@orca/process-host', () => ({ runProcess: mocks.runProcess }))
vi.mock('./codex-shared-server-probe', () => ({
  probeCodexSharedServer: mocks.probeCodexSharedServer
}))

import {
  disableCodexSharedServerAutoStart,
  readFeatureEnabled,
  resolveCodexSharedServerBinary,
  stopCodexSharedServer
} from './codex-shared-server-fix'

const FILE_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex'
const LIST_OFF = 'apps            stable       true\ndaemon_auto_start  experimental  false\n'
const LIST_ON = 'daemon_auto_start  experimental  true\n'
let home: string

function installPackage(...segments: string[]): string {
  const binary = join(home, 'packages', ...segments, FILE_NAME)
  mkdirSync(join(binary, '..'), { recursive: true })
  writeFileSync(binary, '')
  return binary
}

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

beforeEach(() => {
  vi.resetAllMocks()
  home = mkdtempSync(join(tmpdir(), 'codex-shared-server-fix-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe('resolveCodexSharedServerBinary', () => {
  it('prefers the server package over the legacy standalone one', async () => {
    const server = installPackage('app-server-daemon', 'current', 'bin')
    installPackage('standalone', 'current')
    expect(await resolveCodexSharedServerBinary(home)).toBe(server)
  })

  it('falls back to the legacy standalone layout', async () => {
    const legacy = installPackage('standalone', 'current')
    expect(await resolveCodexSharedServerBinary(home)).toBe(legacy)
  })

  it('is null when no package is installed', async () => {
    expect(await resolveCodexSharedServerBinary(home)).toBeNull()
  })
})

describe('readFeatureEnabled', () => {
  it.each([
    [LIST_OFF, false],
    [LIST_ON, true],
    ['apps  stable  true\n', null],
    ['daemon_auto_start  experimental  maybe\n', null],
    ['daemon_auto_start_v2  experimental  false\n', null]
  ])('reads %j as %s', (stdout, expected) => {
    expect(readFeatureEnabled(stdout, 'daemon_auto_start')).toBe(expected)
  })
})

describe('disableCodexSharedServerAutoStart', () => {
  it("runs the server's own Codex on the pane's home, then reads the setting back", async () => {
    const binary = installPackage('app-server-daemon', 'current', 'bin')
    mocks.runProcess
      .mockResolvedValueOnce(result())
      .mockResolvedValueOnce(result({ stdout: LIST_OFF }))

    expect(await disableCodexSharedServerAutoStart(home)).toBe(true)

    const [disable, list] = mocks.runProcess.mock.calls.map(([spec]) => spec)
    expect(disable).toMatchObject({
      program: binary,
      args: ['features', 'disable', 'daemon_auto_start'],
      cwd: dirname(binary),
      env: expect.objectContaining({ CODEX_HOME: home }),
      timeoutMs: 15_000
    })
    expect(disable?.maxOutputBytes).toBeLessThanOrEqual(64 * 1024)
    expect(list).toMatchObject({ program: binary, args: ['features', 'list'] })
  })

  it.each([
    ['managed config keeps it on', [result(), result({ stdout: LIST_ON })]],
    ['the read-back times out', [result(), result({ timedOut: true, code: null })]],
    ['the read-back fails', [result(), result({ code: 1, stdout: LIST_OFF })]]
  ])('fails when %s', async (_label, results) => {
    installPackage('app-server-daemon', 'current', 'bin')
    for (const next of results) {
      mocks.runProcess.mockResolvedValueOnce(next)
    }
    expect(await disableCodexSharedServerAutoStart(home)).toBe(false)
  })

  it.each([
    ['exits non-zero, as an old Codex without the feature does', result({ code: 1 })],
    ['times out', result({ timedOut: true, code: null })]
  ])('skips the read-back when the write %s', async (_label, write) => {
    installPackage('app-server-daemon', 'current', 'bin')
    mocks.runProcess
      .mockResolvedValueOnce(write)
      .mockResolvedValueOnce(result({ stdout: LIST_OFF }))
    expect(await disableCodexSharedServerAutoStart(home)).toBe(false)
    expect(mocks.runProcess).toHaveBeenCalledTimes(1)
  })

  it('fails without running anything when the binary is missing', async () => {
    expect(await disableCodexSharedServerAutoStart(home)).toBe(false)
    expect(mocks.runProcess).not.toHaveBeenCalled()
  })

  it('fails when the spawn throws', async () => {
    installPackage('app-server-daemon', 'current', 'bin')
    mocks.runProcess.mockRejectedValueOnce(new Error('ENOENT'))
    expect(await disableCodexSharedServerAutoStart(home)).toBe(false)
  })
})

describe('stopCodexSharedServer', () => {
  it('succeeds only once a fresh probe finds no server', async () => {
    installPackage('app-server-daemon', 'current', 'bin')
    mocks.runProcess.mockResolvedValueOnce(result())
    mocks.probeCodexSharedServer.mockResolvedValueOnce('absent')

    expect(await stopCodexSharedServer(home)).toBe(true)
    expect(mocks.runProcess.mock.calls[0]?.[0]).toMatchObject({
      args: ['app-server', 'daemon', 'stop'],
      env: expect.objectContaining({ CODEX_HOME: home })
    })
  })

  it('fails when the server is still live after a clean exit', async () => {
    installPackage('app-server-daemon', 'current', 'bin')
    mocks.runProcess.mockResolvedValueOnce(result())
    mocks.probeCodexSharedServer.mockResolvedValueOnce('live')
    expect(await stopCodexSharedServer(home)).toBe(false)
  })

  it('succeeds on a failed exit once the server is gone', async () => {
    installPackage('app-server-daemon', 'current', 'bin')
    mocks.runProcess.mockResolvedValueOnce(result({ code: 1 }))
    mocks.probeCodexSharedServer.mockResolvedValueOnce('absent')
    expect(await stopCodexSharedServer(home)).toBe(true)
  })

  it('fails when the probe cannot tell whether the server is gone', async () => {
    installPackage('app-server-daemon', 'current', 'bin')
    mocks.runProcess.mockResolvedValueOnce(result())
    mocks.probeCodexSharedServer.mockResolvedValueOnce('unknown')
    expect(await stopCodexSharedServer(home)).toBe(false)
  })

  it('fails without running anything when the binary is missing and the server is live', async () => {
    mocks.probeCodexSharedServer.mockResolvedValueOnce('live')
    expect(await stopCodexSharedServer(home)).toBe(false)
    expect(mocks.runProcess).not.toHaveBeenCalled()
  })
})
