import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createFakeSpawnedChild } from '../../../shared/__fixtures__/fake-spawned-child'

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

import { buildSshArgs } from './system-ssh-args'
import { spawnSystemSshCommand } from './system-ssh-command'
import { uploadDirectoryViaSystemSsh, writeFileViaSystemSsh } from './system-ssh-file-transfer'
import type { SshTarget } from '../../../shared/ssh-types'
import type { SystemSshResolvedConfig } from '../ssh-control-socket'

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

function createResolvedConfig(
  overrides?: Partial<SystemSshResolvedConfig>
): SystemSshResolvedConfig {
  return {
    hostname: 'example.com',
    port: 22,
    identityFile: [],
    forwardAgent: false,
    identitiesOnly: false,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no',
    ...overrides
  }
}

function expectNoOrcaControlMasterArgs(args: string[]): void {
  expect(args).not.toContain('ControlMaster=auto')
  expect(args.some((arg) => arg.startsWith('ControlPath='))).toBe(false)
  expect(args).not.toContain('ControlPersist=300')
}

function createEventedProcess() {
  const proc = createFakeSpawnedChild(12345)
  const stdin = Object.assign(proc.stdin, {
    write: vi.spyOn(proc.stdin, 'write'),
    end: vi.spyOn(proc.stdin, 'end')
  })
  return Object.assign(proc, { stdin })
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
  let mockProc: {
    stdin: {
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
    }
    stdout: { on: ReturnType<typeof vi.fn> }
    stderr: { on: ReturnType<typeof vi.fn> }
    pid: number
    on: ReturnType<typeof vi.fn>
    kill: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    existsSyncMock.mockReset()
    spawnMock.mockReset()

    mockProc = {
      stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      pid: 12345,
      on: vi.fn(),
      kill: vi.fn()
    }
    spawnMock.mockReturnValue(mockProc)
    mockSystemSshExists()
  })

  it('uses configHost without resolved field overrides so OpenSSH sees the Host block', () => {
    const args = buildSshArgs(
      createTarget({
        configHost: 'fdpass-host',
        host: 'resolved.example.com',
        port: 2222,
        username: 'deploy',
        identityFile: '/tmp/key',
        identityAgent: '/tmp/agent.sock',
        proxyCommand: 'ignored'
      })
    )

    expect(args).toContain('fdpass-host')
    expect(args).not.toContain('deploy@fdpass-host')
    expect(args).not.toContain('resolved.example.com')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('IdentityAgent=/tmp/agent.sock')
    expect(args).not.toContain('ProxyCommand=ignored')
  })

  it('states the stored endpoint when no Host block claims the alias', () => {
    // #11746: Host * can retain a deleted alias's proxy, making it appear config-backed.
    const args = buildSshArgs(
      createTarget({
        source: 'ssh-config',
        configHost: 'prod',
        host: '10.0.0.5',
        port: 2222,
        username: 'deploy'
      }),
      { aliasClaimedByConfig: false }
    )

    expect(args).toContain('Hostname=10.0.0.5')
    expect(args.slice(args.indexOf('-p'))).toContain('2222')
    expect(args.slice(args.indexOf('-l'))).toContain('deploy')
    expect(args.at(-1)).toBe('prod')
    expect(args).not.toContain('deploy@prod')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('-J')
  })

  it('restricts Kerberos probes to non-interactive GSSAPI authentication', () => {
    spawnSystemSshCommand(
      createTarget({
        configHost: 'krb-host; touch /tmp/not-run',
        source: 'ssh-config',
        gssapiAuthentication: true
      }),
      'echo ready',
      { gssapiOnly: true, wrapCommand: false }
    )

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toEqual(
      expect.arrayContaining([
        '-o',
        'BatchMode=yes',
        '-o',
        'GSSAPIAuthentication=yes',
        '-o',
        'PreferredAuthentications=gssapi-with-mic'
      ])
    )
    expect(args).not.toContain('BatchMode=no')
    const standaloneControlIdx = args.indexOf('-S')
    expect(standaloneControlIdx).toBeGreaterThan(-1)
    expect(args[standaloneControlIdx + 1]).toBe('none')
    expect(args.at(-2)).toBe('krb-host; touch /tmp/not-run')
    expect(args.at(-1)).toBe('echo ready')
  })

  it('does not inject Orca ControlMaster flags when ssh config already owns muxing', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig({
        controlMaster: 'auto',
        controlPath: '/Users/me/.ssh/cm/%r@%h:%p',
        controlPersist: '10m'
      })
    })

    expectNoOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
    expect(args).toContain('workbox')
  })

  it('does not inject Orca ControlMaster flags for unresolved ssh-config targets', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }))

    expectNoOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
    expect(args).toContain('workbox')
  })

  it('forces standalone SSH when target connection reuse is disabled', () => {
    const args = buildSshArgs(createTarget({ systemSshConnectionReuse: false }))
    const standaloneControlIdx = args.indexOf('-S')

    expect(standaloneControlIdx).toBeGreaterThan(-1)
    expect(args[standaloneControlIdx + 1]).toBe('none')
    expectNoOrcaControlMasterArgs(args)
  })

  it('removes wrapped process listeners after command close', () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)

    const channel = spawnSystemSshCommand(createTarget(), 'echo hello')
    const onClose = vi.fn()
    channel.on('close', onClose)
    proc.emit('close', 0, null)

    expect(onClose).toHaveBeenCalledWith(0, null)
    expect(proc.stdout.listenerCount('data')).toBe(0)
    expect(proc.stdout.listenerCount('end')).toBe(0)
    expect(proc.stdout.listenerCount('error')).toBe(0)
    expect(proc.stdin.listenerCount('error')).toBe(0)
    expect(proc.listenerCount('exit')).toBe(0)
    expect(proc.listenerCount('close')).toBe(0)
    expect(proc.listenerCount('error')).toBe(0)
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
