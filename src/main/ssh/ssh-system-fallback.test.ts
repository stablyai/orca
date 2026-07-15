import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

import {
  buildSshArgs,
  findSystemSsh,
  downloadFileViaSystemSsh,
  spawnSystemSsh,
  spawnSystemSshCommand,
  uploadDirectoryViaSystemSsh,
  uploadFileViaSystemSsh,
  writeBufferViaSystemSsh,
  writeFileViaSystemSsh
} from './ssh-system-fallback'
import { spawnSystemSshPortForward } from './system-ssh-forward-process'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshTarget } from '../../shared/ssh-types'
import type { SystemSshResolvedConfig } from './ssh-control-socket'

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+(\S+)/)?.[1]
  return encoded ? Buffer.from(encoded, 'base64').toString('utf16le') : command
}

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

type EventedProcess = EventEmitter & {
  stdin: EventEmitter & {
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
  }
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
  exitCode: number | null
  killed: boolean
}

function createEventedProcess(): EventedProcess {
  const proc = new EventEmitter() as EventedProcess
  proc.stdin = Object.assign(new EventEmitter(), {
    write: vi.fn((_chunk, _encoding, cb?: (err?: Error | null) => void) => cb?.()),
    end: vi.fn()
  })
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.pid = 12345
  proc.kill = vi.fn()
  proc.exitCode = null
  proc.killed = false
  return proc
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

describe('findSystemSsh', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
  })

  it('returns the first existing ssh path', () => {
    mockSystemSshExists()
    expect(findSystemSsh()).toBe(SYSTEM_SSH_PATH)
  })

  it('returns null when no ssh binary is found', () => {
    existsSyncMock.mockReturnValue(false)
    expect(findSystemSsh()).toBeNull()
  })
})

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

  it('spawns ssh with correct arguments for basic target', () => {
    spawnSystemSsh(createTarget())

    expect(spawnMock).toHaveBeenCalledWith(
      SYSTEM_SSH_PATH,
      expect.arrayContaining(['-T', 'deploy@example.com']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('includes port flag when not 22', () => {
    spawnSystemSsh(createTarget({ port: 2222 }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-p')
    expect(args).toContain('2222')
  })

  it('does not include port flag when port is 22', () => {
    spawnSystemSsh(createTarget({ port: 22 }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).not.toContain('-p')
  })

  it('includes identity file flag', () => {
    spawnSystemSsh(createTarget({ identityFile: '/home/user/.ssh/id_ed25519' }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-i')
    expect(args).toContain('/home/user/.ssh/id_ed25519')
  })

  it('includes identity agent option', () => {
    spawnSystemSsh(createTarget({ identityAgent: '/home/user/.1password/agent.sock' }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-o')
    expect(args).toContain('IdentityAgent=/home/user/.1password/agent.sock')
  })

  it('includes identities only option', () => {
    spawnSystemSsh(createTarget({ identitiesOnly: true }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-o')
    expect(args).toContain('IdentitiesOnly=yes')
  })

  it('includes jump host flag', () => {
    spawnSystemSsh(createTarget({ jumpHost: 'bastion.example.com' }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-J')
    expect(args).toContain('bastion.example.com')
  })

  it('includes proxy command flag', () => {
    spawnSystemSsh(createTarget({ proxyCommand: 'ssh -W %h:%p bastion' }))

    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('-o')
    expect(args).toContain('ProxyCommand=ssh -W %h:%p bastion')
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

    expect(args).toContain('deploy@fdpass-host')
    expect(args).not.toContain('resolved.example.com')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('IdentityAgent=/tmp/agent.sock')
    expect(args).not.toContain('ProxyCommand=ignored')
  })

  it('passes explicit options for manual targets with implicit configHost', () => {
    const args = buildSshArgs(
      createTarget({
        source: 'manual',
        configHost: '127.0.0.1',
        host: '127.0.0.1',
        port: 2222,
        identityFile: '/tmp/orca-docker-key',
        identitiesOnly: true
      })
    )

    expect(args).toEqual(expect.arrayContaining(['-p', '2222', '-i', '/tmp/orca-docker-key']))
    expect(args).toContain('IdentitiesOnly=yes')
    expect(args).toContain('deploy@127.0.0.1')
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
    expect(args).toContain('deploy@workbox')
  })

  it('injects Orca ControlMaster flags when ssh config only sets ControlPersist', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig({
        controlMaster: 'no',
        controlPersist: '10m'
      })
    })

    expect(args).toContain('ControlMaster=auto')
    expect(args.some((arg) => arg.startsWith('ControlPath='))).toBe(true)
    expect(args).toContain('ControlPersist=300')
    expect(args).not.toContain('-S')
  })

  it('injects Orca ControlMaster flags when ssh config only sets ControlPath', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig({
        controlMaster: 'no',
        controlPath: '/Users/me/.ssh/cm/%r@%h:%p'
      })
    })

    expect(args).toContain('ControlMaster=auto')
    expect(args.some((arg) => arg.startsWith('ControlPath='))).toBe(true)
    expect(args).toContain('ControlPersist=300')
    expect(args).not.toContain('-S')
  })

  it('injects Orca ControlMaster flags when ssh config omits ControlPath', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig({
        controlMaster: 'auto'
      })
    })

    expect(args).toContain('ControlMaster=auto')
    expect(args.some((arg) => arg.startsWith('ControlPath='))).toBe(true)
    expect(args).toContain('ControlPersist=300')
    expect(args).not.toContain('-S')
  })

  it('does not inject Orca ControlMaster flags for unresolved ssh-config targets', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }))

    expectNoOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
    expect(args).toContain('deploy@workbox')
  })

  it('does not inject Orca ControlMaster flags for unresolved legacy config aliases', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', host: 'resolved.example.com' }))

    expectNoOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
    expect(args).toContain('deploy@workbox')
  })

  it('can inject Orca ControlMaster flags for ssh-config targets with resolved config', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig()
    })

    expect(args).toContain('ControlMaster=auto')
    expect(args.some((arg) => arg.startsWith('ControlPath='))).toBe(true)
    expect(args).toContain('ControlPersist=300')
    expect(args).not.toContain('-S')
  })

  it('forces standalone SSH when target connection reuse is disabled', () => {
    const args = buildSshArgs(createTarget({ systemSshConnectionReuse: false }))
    const standaloneControlIdx = args.indexOf('-S')

    expect(standaloneControlIdx).toBeGreaterThan(-1)
    expect(args[standaloneControlIdx + 1]).toBe('none')
    expectNoOrcaControlMasterArgs(args)
  })

  it('adds keepalive options to Orca-owned ControlMaster connections', () => {
    const args = buildSshArgs(createTarget(), { resolvedConfig: createResolvedConfig() })

    expect(args).toContain('ControlMaster=auto')
    expect(args).toContain('ControlPersist=300')
    expect(args).toContain('ServerAliveInterval=15')
    expect(args).toContain('ServerAliveCountMax=3')
  })

  it('spawns a remote command through the system ssh target', () => {
    spawnSystemSshCommand(createTarget({ configHost: 'fdpass-host' }), 'echo hello')

    expect(spawnMock).toHaveBeenCalledWith(
      SYSTEM_SSH_PATH,
      expect.arrayContaining(['--', 'deploy@fdpass-host', "exec /bin/sh -c 'echo hello'"]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('spawns port forwards before the ssh destination terminator', () => {
    spawnSystemSshPortForward(createTarget({ configHost: 'fdpass-host' }), 5173, '127.0.0.1', 3000)

    const args = spawnMock.mock.calls[0][1] as string[]
    const terminatorIdx = args.indexOf('--')
    const forwardFlagIdx = args.indexOf('-N')
    const localForwardIdx = args.indexOf('-L')
    const exitOnForwardFailureIdx = args.indexOf('ExitOnForwardFailure=yes')
    const standaloneControlIdx = args.indexOf('-S')

    expect(terminatorIdx).toBeGreaterThan(-1)
    expect(forwardFlagIdx).toBeGreaterThan(-1)
    expect(localForwardIdx).toBeGreaterThan(-1)
    expect(exitOnForwardFailureIdx).toBeGreaterThan(-1)
    // Why: -N and -L must appear before -- or OpenSSH treats them as remote command args.
    expect(forwardFlagIdx).toBeLessThan(terminatorIdx)
    expect(localForwardIdx).toBeLessThan(terminatorIdx)
    expect(args[exitOnForwardFailureIdx - 1]).toBe('-o')
    expect(exitOnForwardFailureIdx).toBeLessThan(terminatorIdx)
    expect(standaloneControlIdx).toBe(-1)
    expectNoOrcaControlMasterArgs(args)
    expect(args).toContain('127.0.0.1:5173:127.0.0.1:3000')
    expect(args[terminatorIdx + 1]).toBe('deploy@fdpass-host')
    expect(spawnMock).toHaveBeenCalledWith(
      SYSTEM_SSH_PATH,
      expect.any(Array),
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] })
    )
  })

  it('can spawn a native remote command without the POSIX shell wrapper', () => {
    spawnSystemSshCommand(createTarget({ configHost: 'fdpass-host' }), 'echo hello', {
      wrapCommand: false
    })

    expect(spawnMock).toHaveBeenCalledWith(
      SYSTEM_SSH_PATH,
      expect.arrayContaining(['--', 'deploy@fdpass-host', 'echo hello']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('exposes child stdin so remote commands receive EOF', () => {
    const channel = spawnSystemSshCommand(createTarget(), 'cat > /tmp/file')

    channel.stdin.end('contents')

    expect(mockProc.stdin.end).toHaveBeenCalledWith('contents')
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

  it('removes write command wait listeners after close', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)

    const promise = writeFileViaSystemSsh(createTarget(), '/tmp/file', 'contents')
    proc.emit('close', 0, null)

    await expect(promise).resolves.toBeUndefined()
    expect(proc.stdin.end).toHaveBeenCalledWith(Buffer.from('contents'))
    expect(proc.stderr.listenerCount('data')).toBe(0)
  })

  it('writes binary buffers to POSIX system SSH targets with exclusive create', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)

    const promise = writeBufferViaSystemSsh(createTarget(), '/tmp/file', Buffer.from('png'), {
      exclusive: true
    })
    proc.emit('close', 0, null)

    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args.at(-1)).toContain('set -C; cat >')
    expect(args.at(-1)).toContain('/tmp/file')
    expect(proc.stdin.end).toHaveBeenCalledWith(Buffer.from('png'))
  })

  it('streams a local file through one POSIX system SSH command', async () => {
    const proc = createMockChildProcess()
    const received: Buffer[] = []
    proc.stdin.on('data', (chunk: Buffer) => received.push(chunk))
    spawnMock.mockReturnValue(proc)
    const dir = mkdtempSync(join(tmpdir(), 'orca-system-ssh-upload-'))
    const source = join(dir, 'payload.bin')
    writeFileSync(source, Buffer.from('payload'))

    try {
      const promise = uploadFileViaSystemSsh(createTarget(), source, '/remote/payload.bin', {
        exclusive: true
      })
      await new Promise<void>((resolve) => proc.stdin.once('finish', resolve))
      proc.emit('close', 0, null)

      await expect(promise).resolves.toBeUndefined()
      expect(Buffer.concat(received)).toEqual(Buffer.from('payload'))
      expect(spawnMock).toHaveBeenCalledTimes(1)
      const args = spawnMock.mock.calls[0][1] as string[]
      expect(args.at(-1)).toContain('set -C; cat >')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('appends binary buffers to POSIX system SSH targets', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)

    const promise = writeBufferViaSystemSsh(createTarget(), '/tmp/file', Buffer.from('more'), {
      append: true
    })
    proc.emit('close', 0, null)

    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args.at(-1)).toContain('cat >>')
    expect(args.at(-1)).toContain('/tmp/file')
    expect(args.at(-1)).not.toContain('set -C')
  })

  it('downloads files from POSIX system SSH targets', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)
    const dir = mkdtempSync(join(tmpdir(), 'orca-system-ssh-download-'))
    const dest = join(dir, 'payload.bin')

    try {
      const promise = downloadFileViaSystemSsh(createTarget(), '/remote/payload.bin', dest)
      proc.stdout.emit('data', Buffer.from('payload'))
      proc.stdout.emit('end')
      proc.emit('close', 0, null)

      await expect(promise).resolves.toBeUndefined()
      expect(readFileSync(dest)).toEqual(Buffer.from('payload'))
      const args = spawnMock.mock.calls[0][1] as string[]
      expect(args.at(-1)).toContain('cat')
      expect(args.at(-1)).toContain('/remote/payload.bin')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forces standalone SSH for POSIX file writes when requested', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)

    const promise = writeFileViaSystemSsh(createTarget(), '/tmp/file', 'contents', {
      disableControlMaster: true
    })
    proc.emit('close', 0, null)

    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0][1] as string[]
    const standaloneControlIdx = args.indexOf('-S')
    expect(standaloneControlIdx).toBeGreaterThan(-1)
    expect(args[standaloneControlIdx + 1]).toBe('none')
  })

  it('writes files to Windows system SSH targets with PowerShell stdin bytes', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    const promise = writeFileViaSystemSsh(
      createTarget(),
      'C:/Users/me/.orca-remote/relay/.version',
      '0.1.0',
      { hostPlatform }
    )
    proc.emit('close', 0, null)

    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0][1] as string[]
    const remoteCommand = args.at(-1) ?? ''
    expect(remoteCommand).toContain('powershell.exe')
    expect(remoteCommand).not.toContain('/bin/sh')
    expect(proc.stdin.end).toHaveBeenCalledWith(Buffer.from('0.1.0', 'utf-8'))
  })

  it('writes binary buffers to Windows system SSH targets with CreateNew mode', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    const promise = writeBufferViaSystemSsh(
      createTarget(),
      'C:/Users/me/logo.png',
      Buffer.from('png'),
      { hostPlatform, exclusive: true }
    )
    proc.emit('close', 0, null)

    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0][1] as string[]
    const remoteCommand = args.at(-1) ?? ''
    expect(remoteCommand).toContain('powershell.exe')
    expect(decodePowerShellCommand(remoteCommand)).toContain('CreateNew')
    expect(remoteCommand).not.toContain('/bin/sh')
    expect(proc.stdin.end).toHaveBeenCalledWith(Buffer.from('png'))
  })

  it('downloads files from Windows system SSH targets with PowerShell stdout bytes', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)
    const hostPlatform = getRemoteHostPlatform('win32-x64')
    const dir = mkdtempSync(join(tmpdir(), 'orca-system-ssh-download-'))
    const dest = join(dir, 'payload.bin')

    try {
      const promise = downloadFileViaSystemSsh(createTarget(), 'C:/Users/me/payload.bin', dest, {
        hostPlatform
      })
      proc.stdout.emit('data', Buffer.from('payload'))
      proc.stdout.emit('end')
      proc.emit('close', 0, null)

      await expect(promise).resolves.toBeUndefined()
      expect(readFileSync(dest)).toEqual(Buffer.from('payload'))
      const args = spawnMock.mock.calls[0][1] as string[]
      const remoteCommand = args.at(-1) ?? ''
      expect(remoteCommand).toContain('powershell.exe')
      expect(decodePowerShellCommand(remoteCommand)).toContain('OpenRead')
      expect(decodePowerShellCommand(remoteCommand)).toContain('CopyTo')
      expect(remoteCommand).not.toContain('/bin/sh')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('forces standalone SSH for Windows file writes when requested', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    const promise = writeFileViaSystemSsh(
      createTarget(),
      'C:/Users/me/.orca-remote/relay/.version',
      '0.1.0',
      { hostPlatform, disableControlMaster: true }
    )
    proc.emit('close', 0, null)

    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0][1] as string[]
    const standaloneControlIdx = args.indexOf('-S')
    expect(standaloneControlIdx).toBeGreaterThan(-1)
    expect(args[standaloneControlIdx + 1]).toBe('none')
  })

  it('uploads directories to Windows system SSH targets in one PowerShell batch', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'orca-system-ssh-upload-'))
    writeFileSync(join(localDir, 'relay.js'), 'console.log("relay")')
    const spawned: EventedProcess[] = []
    spawnMock.mockImplementation(() => {
      const proc = createEventedProcess()
      spawned.push(proc)
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    })

    try {
      await uploadDirectoryViaSystemSsh(
        createTarget(),
        localDir,
        'C:/Users/me/.orca-remote/relay',
        { hostPlatform: getRemoteHostPlatform('win32-x64') }
      )
    } finally {
      rmSync(localDir, { recursive: true, force: true })
    }

    const commands = spawnMock.mock.calls.map((call) => (call[1] as string[]).at(-1) ?? '')
    expect(commands).toHaveLength(1)
    expect(commands.every((command) => command.includes('powershell.exe'))).toBe(true)
    expect(commands.every((command) => !command.includes('/bin/sh'))).toBe(true)
    expect(commands.join('\n')).not.toContain('tar -xzf')
    const payload = JSON.parse(spawned[0].stdin.end.mock.calls[0]?.[0] as string) as {
      kind: string
      path: string
      contentsBase64?: string
    }[]
    expect(payload).toEqual(
      expect.arrayContaining([
        { kind: 'directory', path: 'C:/Users/me/.orca-remote/relay' },
        {
          kind: 'file',
          path: 'C:/Users/me/.orca-remote/relay/relay.js',
          contentsBase64: Buffer.from('console.log("relay")').toString('base64')
        }
      ])
    )
  })

  it('forces standalone SSH for Windows upload packages when requested', async () => {
    const localDir = mkdtempSync(join(tmpdir(), 'orca-system-ssh-upload-'))
    writeFileSync(join(localDir, 'relay.js'), 'console.log("relay")')
    spawnMock.mockImplementation(() => {
      const proc = createEventedProcess()
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    })

    try {
      await uploadDirectoryViaSystemSsh(
        createTarget(),
        localDir,
        'C:/Users/me/.orca-remote/relay',
        { hostPlatform: getRemoteHostPlatform('win32-x64'), disableControlMaster: true }
      )
    } finally {
      rmSync(localDir, { recursive: true, force: true })
    }

    const args = spawnMock.mock.calls[0][1] as string[]
    const standaloneControlIdx = args.indexOf('-S')
    expect(standaloneControlIdx).toBeGreaterThan(-1)
    expect(args[standaloneControlIdx + 1]).toBe('none')
  })

  it('throws when no system ssh is found', () => {
    existsSyncMock.mockReturnValue(false)
    expect(() => spawnSystemSsh(createTarget())).toThrow('No system ssh binary found')
  })

  it('returns a process wrapper with kill and onExit', () => {
    const result = spawnSystemSsh(createTarget())

    expect(result.pid).toBe(12345)
    expect(typeof result.kill).toBe('function')
    expect(typeof result.onExit).toBe('function')
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
