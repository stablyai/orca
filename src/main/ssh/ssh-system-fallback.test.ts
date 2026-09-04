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

function expectOrcaControlMasterArgs(args: string[]): void {
  if (process.platform === 'win32') {
    expectNoOrcaControlMasterArgs(args)
    return
  }
  expect(args).toContain('ControlMaster=auto')
  expect(args.some((arg) => arg.startsWith('ControlPath='))).toBe(true)
  expect(args).toContain('ControlPersist=300')
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

// Windows writes read their source asynchronously before spawning, so a close emitted straight
// after the call can beat the listener. Emit it from the spawn instead.
function closeOnceSpawned(proc: EventedProcess): EventedProcess {
  setImmediate(() => proc.emit('close', 0, null))
  return proc
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

    expect(args).toContain('fdpass-host')
    expect(args).not.toContain('deploy@fdpass-host')
    expect(args).not.toContain('resolved.example.com')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('IdentityAgent=/tmp/agent.sock')
    expect(args).not.toContain('ProxyCommand=ignored')
  })

  it('states the stored endpoint when no Host block claims the alias', () => {
    // A wildcard `Host *` supplies the proxy for every alias, so an alias whose own block is gone
    // still reads as config-backed and gets dialled bare - the #11746 P1.
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
    // The alias is still the destination so OpenSSH keeps applying the wildcard's proxy.
    expect(args.at(-1)).toBe('prod')
    expect(args).not.toContain('deploy@prod')
    expect(args).not.toContain('-i')
    expect(args).not.toContain('-J')
  })

  it('stays a no-op when the stored endpoint matches the unclaimed alias', () => {
    const args = buildSshArgs(
      createTarget({ source: 'ssh-config', configHost: 'prod', host: 'prod', username: '' }),
      { aliasClaimedByConfig: false }
    )

    expect(args.some((arg) => arg.startsWith('Hostname='))).toBe(false)
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-l')
    expect(args.at(-1)).toBe('prod')
  })

  it('leaves a manual target alone even when nothing claims its alias', () => {
    const args = buildSshArgs(
      createTarget({ source: 'manual', configHost: 'prod', host: '10.0.0.5', port: 2222 }),
      { aliasClaimedByConfig: false }
    )

    expect(args.some((arg) => arg.startsWith('Hostname='))).toBe(false)
    expect(args).toContain('deploy@prod')
  })

  it('passes an explicit main-owned OpenSSH config as one argument', () => {
    const args = buildSshArgs(createTarget({ configHost: 'isolated-host', source: 'ssh-config' }), {
      configFile: '/tmp/orca isolated/ssh_config'
    })

    expect(args.slice(0, 2)).toEqual(['-F', '/tmp/orca isolated/ssh_config'])
    expect(args).toContain('isolated-host')
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

  it('requests GSSAPI authentication explicitly for manual targets', () => {
    const args = buildSshArgs(
      createTarget({ source: 'manual', configHost: 'krb.example.com', gssapiAuthentication: true })
    )

    expect(args).toContain('GSSAPIAuthentication=yes')
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

  it('leaves GSSAPI to the Host block for ssh-config targets', () => {
    const args = buildSshArgs(
      createTarget({ configHost: 'krb-host', source: 'ssh-config', gssapiAuthentication: true })
    )

    expect(args).not.toContain('GSSAPIAuthentication=yes')
    expect(args).toContain('krb-host')
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

  it('injects Orca ControlMaster flags when ssh config only sets ControlPersist', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig({
        controlMaster: 'no',
        controlPersist: '10m'
      })
    })

    expectOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
  })

  it('injects Orca ControlMaster flags when ssh config only sets ControlPath', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig({
        controlMaster: 'no',
        controlPath: '/Users/me/.ssh/cm/%r@%h:%p'
      })
    })

    expectOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
  })

  it('injects Orca ControlMaster flags when ssh config omits ControlPath', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig({
        controlMaster: 'auto'
      })
    })

    expectOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
  })

  it('does not inject Orca ControlMaster flags for unresolved ssh-config targets', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }))

    expectNoOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
    expect(args).toContain('workbox')
  })

  it('does not inject Orca ControlMaster flags for unresolved legacy config aliases', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', host: 'resolved.example.com' }))

    expectNoOrcaControlMasterArgs(args)
    expect(args).not.toContain('-S')
    expect(args).toContain('workbox')
  })

  it('can inject Orca ControlMaster flags for ssh-config targets with resolved config', () => {
    const args = buildSshArgs(createTarget({ configHost: 'workbox', source: 'ssh-config' }), {
      resolvedConfig: createResolvedConfig()
    })

    expectOrcaControlMasterArgs(args)
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

    expectOrcaControlMasterArgs(args)
    if (process.platform !== 'win32') {
      expect(args).toContain('ServerAliveInterval=15')
      expect(args).toContain('ServerAliveCountMax=3')
    }
  })

  it('spawns a remote command through the system ssh target', () => {
    spawnSystemSshCommand(createTarget({ configHost: 'fdpass-host' }), 'echo hello')

    // Why: the remote command stays on one line so csh/tcsh login shells cannot
    // split it before /bin/sh receives it.
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--')
    expect(args).toContain('fdpass-host')
    const wrapped = args.at(-1)!
    expect(wrapped).not.toContain('\n')
    expect(wrapped).toContain('printf %b "$@"')
    expect(wrapped).not.toContain('base64')
    expect(spawnMock).toHaveBeenCalledWith(
      SYSTEM_SSH_PATH,
      expect.any(Array),
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
    expect(args[terminatorIdx + 1]).toBe('fdpass-host')
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
      expect.arrayContaining(['--', 'fdpass-host', 'echo hello']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('exposes child stdin so remote commands receive EOF', () => {
    const channel = spawnSystemSshCommand(createTarget(), 'cat > /tmp/file')

    channel.stdin.end('contents')

    expect(mockProc.stdin.end).toHaveBeenCalledWith('contents')
  })

  it('marks a system command channel when local teardown is requested', () => {
    const channel = spawnSystemSshCommand(createTarget(), 'npm install')

    channel.close()

    expect(channel._closeRequested).toBe(true)
    expect(mockProc.kill).toHaveBeenCalledWith('SIGTERM')
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
    spawnMock.mockImplementation(() => closeOnceSpawned(proc))
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    const promise = writeFileViaSystemSsh(
      createTarget(),
      'C:/Users/me/.orca-remote/relay/.version',
      '0.1.0',
      { hostPlatform }
    )

    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0][1] as string[]
    const remoteCommand = args.at(-1) ?? ''
    expect(remoteCommand).toContain('powershell.exe')
    expect(remoteCommand).not.toContain('/bin/sh')
    expect(proc.stdin.end).toHaveBeenCalledWith(Buffer.from('0.1.0', 'utf-8'))
  })

  it('writes binary buffers to Windows system SSH targets with CreateNew mode', async () => {
    const proc = createEventedProcess()
    spawnMock.mockImplementation(() => closeOnceSpawned(proc))
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    const promise = writeBufferViaSystemSsh(
      createTarget(),
      'C:/Users/me/logo.png',
      Buffer.from('png'),
      { hostPlatform, exclusive: true }
    )

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
    spawnMock.mockImplementation(() => closeOnceSpawned(proc))
    const hostPlatform = getRemoteHostPlatform('win32-x64')

    const promise = writeFileViaSystemSsh(
      createTarget(),
      'C:/Users/me/.orca-remote/relay/.version',
      '0.1.0',
      { hostPlatform, disableControlMaster: true }
    )

    await expect(promise).resolves.toBeUndefined()
    const args = spawnMock.mock.calls[0][1] as string[]
    const standaloneControlIdx = args.indexOf('-S')
    expect(standaloneControlIdx).toBeGreaterThan(-1)
    expect(args[standaloneControlIdx + 1]).toBe('none')
  })

  it('uploads a Windows directory as a mkdir batch plus per-file writes, never one blob', async () => {
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
    // #16432: directories first (metadata only), then the file bytes on their own stdin. One batch
    // meant base64-ing the whole bundle into a single PowerShell string, which the remote never read.
    expect(commands).toHaveLength(2)
    expect(commands.every((command) => command.includes('powershell.exe'))).toBe(true)
    expect(commands.every((command) => !command.includes('/bin/sh'))).toBe(true)
    expect(commands.join('\n')).not.toContain('tar -xzf')
    expect(JSON.parse(spawned[0].stdin.end.mock.calls[0]?.[0] as string)).toEqual([
      'C:/Users/me/.orca-remote/relay'
    ])
    expect(Buffer.from(spawned[1].stdin.end.mock.calls[0]?.[0] as Buffer).toString('utf-8')).toBe(
      'console.log("relay")'
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
    vi.stubEnv('PATH', '')
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
