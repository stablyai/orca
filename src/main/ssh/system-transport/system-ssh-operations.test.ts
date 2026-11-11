import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const { existsSyncMock, spawnMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    existsSync: existsSyncMock
  }
})

vi.mock('child_process', () => ({
  spawn: spawnMock
}))

import { spawnSystemSshCommand } from './system-ssh-command'
import {
  uploadDirectoryViaSystemSsh,
  writeFileViaSystemSsh
} from './file-transfer/system-ssh-file-transfer'
import type { SshTarget } from '../../../shared/ssh-types'

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'

function mockSystemSshExists(): void {
  existsSyncMock.mockImplementation((p: string) => p === SYSTEM_SSH_PATH)
}

function createTarget(overrides?: Partial<SshTarget>): SshTarget {
  return {
    id: 'target-1',
    label: 'Test Server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    ...overrides
  }
}

function createMockChildProcess(): EventEmitter & {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill: ReturnType<typeof vi.fn>
  killed: boolean
  exitCode: number | null
} {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
    pid: number
    kill: ReturnType<typeof vi.fn>
    killed: boolean
    exitCode: number | null
  }
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 12345
  child.killed = false
  child.exitCode = null
  child.kill = vi.fn(() => {
    child.killed = true
    return true
  })
  return child
}

describe('spawnSystemSsh', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    spawnMock.mockReset()
    mockSystemSshExists()
  })

  it('pauses command stdout under backpressure and resumes when the channel reads', async () => {
    const proc = createMockChildProcess()
    const pause = vi.spyOn(proc.stdout, 'pause')
    const resume = vi.spyOn(proc.stdout, 'resume')
    spawnMock.mockReturnValue(proc)

    const channel = spawnSystemSshCommand(createTarget(), 'cat /tmp/large-file')
    resume.mockClear()
    proc.stdout.write(Buffer.alloc(128 * 1024))

    expect(pause).toHaveBeenCalled()
    resume.mockClear()
    channel.read()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(resume).toHaveBeenCalled()
  })
})

describe('system SSH operation aborts', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    spawnMock.mockReset()
    mockSystemSshExists()
  })

  it('rejects directory uploads when aborted even if child processes do not close', async () => {
    const tarCreate = createMockChildProcess()
    const sshExtract = createMockChildProcess()
    spawnMock.mockReturnValueOnce(tarCreate).mockReturnValueOnce(sshExtract)
    const controller = new AbortController()

    const uploadPromise = uploadDirectoryViaSystemSsh(
      createTarget(),
      '/tmp/local-relay',
      '/tmp/remote-relay',
      { signal: controller.signal }
    )
    controller.abort()

    const outcome = await Promise.race([
      uploadPromise.then(
        () => 'resolved',
        (error: Error) => error.name
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0))
    ])

    expect(outcome).toBe('AbortError')
    expect(tarCreate.kill).toHaveBeenCalledTimes(1)
    expect(sshExtract.kill).toHaveBeenCalledTimes(1)
  })

  it('rejects remote file writes when aborted even if ssh never closes', async () => {
    const sshProcess = createMockChildProcess()
    spawnMock.mockReturnValueOnce(sshProcess)
    const controller = new AbortController()

    const writePromise = writeFileViaSystemSsh(createTarget(), '/tmp/remote-file', 'contents', {
      signal: controller.signal
    })
    controller.abort()

    const outcome = await Promise.race([
      writePromise.then(
        () => 'resolved',
        (error: Error) => error.name
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0))
    ])

    expect(outcome).toBe('AbortError')
    expect(sshProcess.kill).toHaveBeenCalledTimes(1)
  })
})
