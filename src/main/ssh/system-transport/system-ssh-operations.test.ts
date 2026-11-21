import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

const { accessMock, existsSyncMock, spawnMock } = vi.hoisted(() => ({
  // Windows directory uploads probe System32 tar.exe first; default to it existing.
  accessMock: vi.fn(async () => {}),
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

vi.mock('fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    access: accessMock
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
import type { SshTarget } from '../../../shared/remote-runtime/ssh/ssh-types'

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
    accessMock.mockReset()
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
    // Windows awaits the tar.exe probe before spawning, so abort only once both children exist.
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
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

describe('system SSH directory upload tar binary', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    accessMock.mockReset()
    spawnMock.mockReset()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    vi.unstubAllEnvs()
  })

  it('keeps the inherited cwd for tar on Unix so PATH lookup is unchanged', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    vi.stubEnv('ORCA_SYSTEM_SSH_PATH', '/usr/bin/ssh')
    const tarCreate = createMockChildProcess()
    const sshExtract = createMockChildProcess()
    spawnMock.mockReturnValueOnce(tarCreate).mockReturnValueOnce(sshExtract)

    const uploadPromise = uploadDirectoryViaSystemSsh(
      createTarget(),
      '/local-relay',
      '/tmp/remote-relay'
    )
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
    tarCreate.stdout.end()
    tarCreate.emit('close', 0, null)
    sshExtract.emit('close', 0, null)
    await uploadPromise

    const [program, args, options] = spawnMock.mock.calls[0]
    expect(program).toBe('tar')
    expect(args).toEqual(['-czf', '-', '-C', '/local-relay', '.'])
    expect(options).not.toHaveProperty('cwd')
  })

  it.each([
    { systemTarExists: true, expected: 'D:\\Windows\\System32\\tar.exe' },
    { systemTarExists: false, expected: 'tar' }
  ])(
    'spawns $expected on Windows when System32 tar.exe exists=$systemTarExists',
    async ({ systemTarExists, expected }) => {
      Object.defineProperty(process, 'platform', { value: 'win32' })
      vi.stubEnv('SystemRoot', 'D:\\Windows')
      vi.stubEnv('ORCA_SYSTEM_SSH_PATH', 'D:\\Windows\\System32\\OpenSSH\\ssh.exe')
      accessMock.mockImplementation(async () => {
        if (!systemTarExists) {
          throw new Error('ENOENT')
        }
      })
      const tarCreate = createMockChildProcess()
      const sshExtract = createMockChildProcess()
      spawnMock.mockReturnValueOnce(tarCreate).mockReturnValueOnce(sshExtract)

      const uploadPromise = uploadDirectoryViaSystemSsh(
        createTarget(),
        'C:\\local-relay',
        '/tmp/remote-relay'
      )
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(2))
      tarCreate.stdout.end()
      tarCreate.emit('close', 0, null)
      sshExtract.emit('close', 0, null)
      await uploadPromise

      expect(accessMock).toHaveBeenCalledWith('D:\\Windows\\System32\\tar.exe')
      expect(spawnMock).toHaveBeenNthCalledWith(
        1,
        expected,
        ['-czf', '-', '.'],
        expect.objectContaining({ cwd: 'C:\\local-relay', windowsHide: true })
      )
    }
  )
})
