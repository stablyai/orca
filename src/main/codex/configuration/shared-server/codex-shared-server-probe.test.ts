import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readWindowsProcessCreationTime } = vi.hoisted(() => ({
  readWindowsProcessCreationTime: vi.fn<(pid: number) => number | null>()
}))
vi.mock('../../../windows/windows-process-table', () => ({ readWindowsProcessCreationTime }))

import { runProcess } from '@orca/process-host'
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
  // macOS TMPDIR can exceed the Unix socket path limit.
  home = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cxh-'))
  readWindowsProcessCreationTime.mockReset()
})

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

  it('is absent when a crashed server left its socket file behind', async () => {
    const socketPath = join(home, 'app-server-control', 'app-server-control.sock')
    mkdirSync(join(home, 'app-server-control'), { recursive: true })
    // A crash leaves the socket inode without a listener.
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
    // ENOTDIR does not prove server absence.
    writeFileSync(join(home, 'app-server-control'), '')
    await expect(probeCodexSharedServer(home)).resolves.toBe('unknown')
  })
})
