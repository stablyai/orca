import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

import { resolveCodexSharedServerBinary, stopCodexSharedServer } from './codex-shared-server-fix'

const FILE_NAME = process.platform === 'win32' ? 'codex.exe' : 'codex'

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
})
