import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readWindowsProcessCreationTime } = vi.hoisted(() => ({
  readWindowsProcessCreationTime: vi.fn<(pid: number) => number | null>()
}))
vi.mock('../windows/windows-process-table', () => ({ readWindowsProcessCreationTime }))

import { runProcess } from '../../shared/child-process/run-process'
import { probeCodexSharedServer } from './codex-shared-server-probe'

const originalPlatform = process.platform
let home: string
let server: Server | null = null

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function listen(): Promise<void> {
  mkdirSync(join(home, 'app-server-control'), { recursive: true })
  const listening = createServer((socket) => socket.destroy())
  server = listening
  return new Promise((resolve) =>
    listening.listen(join(home, 'app-server-control', 'app-server-control.sock'), resolve)
  )
}

function close(): Promise<void> {
  const listening = server
  server = null
  return new Promise((resolve) => (listening ? listening.close(() => resolve()) : resolve()))
}

beforeEach(() => {
  // Why /tmp: a unix socket path must fit sun_path, which a macOS $TMPDIR can exceed.
  home = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cxh-'))
  readWindowsProcessCreationTime.mockReset()
})

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

afterEach(async () => {
  vi.restoreAllMocks()
  setPlatform(originalPlatform)
  await close()
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('probeCodexSharedServer on POSIX', () => {
  beforeEach(() => setPlatform('darwin'))

  it('is live while the control socket accepts connections', async () => {
    await listen()
    await expect(probeCodexSharedServer(home)).resolves.toBe('live')
  })

  it('is absent when no socket exists', async () => {
    await expect(probeCodexSharedServer(home)).resolves.toBe('absent')
  })

  it('is absent when a crashed server left its socket file behind', async () => {
    const socketPath = join(home, 'app-server-control', 'app-server-control.sock')
    mkdirSync(join(home, 'app-server-control'), { recursive: true })
    // Why a killed child: only a crash leaves the socket inode with nobody listening.
    await runProcess({
      program: process.execPath,
      args: [
        '-e',
        `require('node:net').createServer().listen(${JSON.stringify(socketPath)}, () => process.kill(process.pid, 'SIGKILL'))`
      ],
      timeoutMs: 10_000
    })
    expect(existsSync(socketPath)).toBe(true)
    await expect(probeCodexSharedServer(home)).resolves.toBe('absent')
  })

  it('is unknown when the socket path cannot be connected to for another reason', async () => {
    // Why a file where the directory goes: connect fails with ENOTDIR, which proves nothing.
    writeFileSync(join(home, 'app-server-control'), '')
    await expect(probeCodexSharedServer(home)).resolves.toBe('unknown')
  })
})

describe('probeCodexSharedServer on Windows', () => {
  const START_FILETIME = '134352704749372843'
  const START_UNIX_MS = 1_790_796_874_937

  beforeEach(() => {
    setPlatform('win32')
    vi.spyOn(process, 'kill').mockReturnValue(true)
  })

  function writeRecord(name: string, record: unknown): void {
    mkdirSync(join(home, 'app-server-daemon'), { recursive: true })
    writeFileSync(
      join(home, 'app-server-daemon', name),
      typeof record === 'string' ? record : JSON.stringify(record)
    )
  }

  it('is live when the recorded pid still has the recorded creation time', async () => {
    writeRecord('daemon.pid', { pid: 27368, processStartTime: START_FILETIME })
    readWindowsProcessCreationTime.mockReturnValue(START_UNIX_MS)
    await expect(probeCodexSharedServer(home)).resolves.toBe('live')
    expect(readWindowsProcessCreationTime).toHaveBeenCalledWith(27368)
  })

  it('reads the legacy record name', async () => {
    writeRecord('app-server.pid', { pid: 27368, processStartTime: START_FILETIME })
    readWindowsProcessCreationTime.mockReturnValue(START_UNIX_MS)
    await expect(probeCodexSharedServer(home)).resolves.toBe('live')
  })

  it('is absent when no record exists', async () => {
    await expect(probeCodexSharedServer(home)).resolves.toBe('absent')
  })

  it('is absent when the recorded pid is not running', async () => {
    writeRecord('daemon.pid', { pid: 27368, processStartTime: START_FILETIME })
    vi.mocked(process.kill).mockImplementation(() => {
      throw errnoError('ESRCH')
    })
    await expect(probeCodexSharedServer(home)).resolves.toBe('absent')
    expect(readWindowsProcessCreationTime).not.toHaveBeenCalled()
  })

  it('is absent when the pid was reused by a later process', async () => {
    writeRecord('daemon.pid', { pid: 27368, processStartTime: START_FILETIME })
    readWindowsProcessCreationTime.mockReturnValue(START_UNIX_MS + 60_000)
    await expect(probeCodexSharedServer(home)).resolves.toBe('absent')
  })

  it.each([
    [
      'access to the pid is denied',
      () =>
        vi.mocked(process.kill).mockImplementation(() => {
          throw errnoError('EPERM')
        })
    ],
    [
      'the creation time cannot be read',
      () => readWindowsProcessCreationTime.mockReturnValue(null)
    ],
    [
      'the record holds no parseable start time',
      () => {
        readWindowsProcessCreationTime.mockReturnValue(START_UNIX_MS)
        writeRecord('daemon.pid', { pid: 27368, processStartTime: 'Wed Sep 30 15:33:16 2026' })
      }
    ],
    ['the record is not JSON', () => writeRecord('daemon.pid', '{')]
  ])('is unknown when %s', async (_label, arrange) => {
    writeRecord('daemon.pid', { pid: 27368, processStartTime: START_FILETIME })
    arrange()
    await expect(probeCodexSharedServer(home)).resolves.toBe('unknown')
  })
})
