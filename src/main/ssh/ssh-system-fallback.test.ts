import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  spawnSystemSsh,
  spawnSystemSshCommand,
  uploadDirectoryViaSystemSsh,
  writeFileViaSystemSsh
} from './ssh-system-fallback'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshTarget } from '../../shared/ssh-types'

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
    existsSyncMock.mockImplementation((p: string) => p === '/usr/bin/ssh')
    expect(findSystemSsh()).toBe('/usr/bin/ssh')
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
    existsSyncMock.mockImplementation((p: string) => p === '/usr/bin/ssh')
  })

  it('spawns ssh with correct arguments for basic target', () => {
    spawnSystemSsh(createTarget())

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ssh',
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

  it('spawns a remote command through the system ssh target', () => {
    spawnSystemSshCommand(createTarget({ configHost: 'fdpass-host' }), 'echo hello')

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ssh',
      expect.arrayContaining(['--', 'deploy@fdpass-host', "exec /bin/sh -c 'echo hello'"]),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    )
  })

  it('can spawn a native remote command without the POSIX shell wrapper', () => {
    spawnSystemSshCommand(createTarget({ configHost: 'fdpass-host' }), 'echo hello', {
      wrapCommand: false
    })

    expect(spawnMock).toHaveBeenCalledWith(
      '/usr/bin/ssh',
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

  it('removes write command wait listeners after close', async () => {
    const proc = createEventedProcess()
    spawnMock.mockReturnValue(proc)

    const promise = writeFileViaSystemSsh(createTarget(), '/tmp/file', 'contents')
    proc.emit('close', 0, null)

    await expect(promise).resolves.toBeUndefined()
    expect(proc.stdin.end).toHaveBeenCalledWith('contents')
    expect(proc.stderr.listenerCount('data')).toBe(0)
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
    existsSyncMock.mockImplementation((p: string) => p === '/usr/bin/ssh')
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
