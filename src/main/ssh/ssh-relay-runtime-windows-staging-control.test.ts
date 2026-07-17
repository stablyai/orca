import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SshRelayRuntimeCommandFileChannel } from './ssh-relay-runtime-command-file-destination'
import {
  runSshRelayRuntimeWindowsStagingControl,
  SSH_RELAY_RUNTIME_WINDOWS_STAGING_CONTROL_LIMITS
} from './ssh-relay-runtime-windows-staging-control'

type Callback = (error?: Error) => void

function createChannel() {
  let resolveSettled: () => void = () => {}
  let rejectSettled: (error: Error) => void = () => {}
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve
    rejectSettled = reject
  })
  const channel = {
    write: vi.fn((_chunk: Buffer, callback: Callback) => callback()),
    end: vi.fn(),
    settled,
    requestClose: vi.fn(),
    forceClose: vi.fn()
  }
  return { channel, resolve: resolveSettled, reject: rejectSettled }
}

function decodeRequest(frame: Buffer) {
  const rootLength = frame.readUInt32LE(12)
  const pathLength = frame.readUInt32LE(16)
  const rootStart = 20
  const pathStart = rootStart + rootLength
  return {
    magic: frame.subarray(0, 8).toString('ascii'),
    operation: frame.readUInt8(8),
    reserved: frame.subarray(9, 12),
    remoteRoot: frame.subarray(rootStart, pathStart).toString('utf8'),
    remotePath: frame.subarray(pathStart, pathStart + pathLength).toString('utf8'),
    completion: frame.subarray(pathStart + pathLength).toString('ascii')
  }
}

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/u)?.[1]
  if (!encoded) {
    throw new Error('PowerShell staging control command is not encoded')
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

function runControl(
  channel: SshRelayRuntimeCommandFileChannel,
  overrides: Partial<Parameters<typeof runSshRelayRuntimeWindowsStagingControl>[0]> = {}
) {
  return runSshRelayRuntimeWindowsStagingControl({
    operation: 'create-directory',
    remoteRoot: 'C:/Users/测试/.orca-remote/stage',
    remotePath: 'C:/Users/测试/.orca-remote/stage/bin/native',
    signal: new AbortController().signal,
    openChannel: vi.fn(async () => channel),
    ...overrides
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SSH relay runtime Windows system-SSH staging control', () => {
  it.each([
    ['create-root', 1, ''],
    ['create-directory', 2, 'C:/Users/测试/.orca-remote/stage/bin/native'],
    ['remove-root', 3, '']
  ] as const)(
    'sends one fixed bounded binary %s request',
    async (operation, opcode, remotePath) => {
      const fixture = createChannel()
      const openChannel = vi.fn(async (_command: string, _signal: AbortSignal) => fixture.channel)
      const running = runControl(fixture.channel, {
        operation,
        remotePath: remotePath || undefined,
        openChannel
      })

      await vi.waitFor(() => expect(fixture.channel.end).toHaveBeenCalledOnce())
      expect(openChannel).toHaveBeenCalledOnce()
      const command = openChannel.mock.calls[0]?.[0] ?? ''
      expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/u)
      expect(command).not.toContain('测试')
      const script = decodePowerShellCommand(command)
      expect(script).toContain('[Console]::OpenStandardInput()')
      expect(script).toContain('New-Item -ItemType Directory -Path')
      expect(script).toContain('[IO.Path]::GetDirectoryName')
      expect(script).toContain('[IO.Directory]::Delete')
      expect(script).toContain("-ne 'ORCAEND1'")
      expect(script).not.toContain('$inputStream.ReadByte()')
      for (const forbidden of ['ReadToEnd', 'FromBase64String', 'ConvertFrom-Json']) {
        expect(script).not.toContain(forbidden)
      }

      const frame = fixture.channel.write.mock.calls[0]?.[0]
      expect(Buffer.isBuffer(frame)).toBe(true)
      expect(frame.length).toBeLessThanOrEqual(
        SSH_RELAY_RUNTIME_WINDOWS_STAGING_CONTROL_LIMITS.maximumRequestBytes
      )
      expect(decodeRequest(frame)).toEqual({
        magic: 'ORCACTL1',
        operation: opcode,
        reserved: Buffer.alloc(3),
        remoteRoot: 'C:/Users/测试/.orca-remote/stage',
        remotePath,
        completion: 'ORCAEND1'
      })
      fixture.resolve()
      await expect(running).resolves.toBeUndefined()
    }
  )

  it.each([
    ['create-root', 'relative/stage', undefined],
    ['create-root', 'C:/', undefined],
    ['create-root', 'C:/owned/../stage', undefined],
    ['create-root', 'C:/owned/NUL', undefined],
    [
      'create-root',
      `C:/${'a'.repeat(SSH_RELAY_RUNTIME_WINDOWS_STAGING_CONTROL_LIMITS.maximumPathBytes)}`,
      undefined
    ],
    ['create-root', 'C:/owned/stage', 'C:/owned/stage/extra'],
    ['create-directory', 'C:/owned/stage', undefined],
    ['create-directory', 'C:/owned/stage', 'C:/outside'],
    ['create-directory', 'C:/owned/stage', 'C:/owned/stage'],
    ['create-directory', 'C:/owned/stage', 'C:/owned/stage/report.txt:stream']
  ] as const)(
    'rejects hostile %s root %j path %j before channel open',
    async (operation, remoteRoot, remotePath) => {
      const fixture = createChannel()
      const openChannel = vi.fn(async () => fixture.channel)
      await expect(
        runControl(fixture.channel, { operation, remoteRoot, remotePath, openChannel })
      ).rejects.toThrow(/invalid/i)
      expect(openChannel).not.toHaveBeenCalled()
    }
  )

  it('settles retained-request cancellation before rejecting', async () => {
    const fixture = createChannel()
    const controller = new AbortController()
    const reason = new Error('cancelled retained Windows control request')
    fixture.channel.write.mockImplementationOnce(() => {})
    fixture.channel.requestClose.mockImplementation(() => fixture.resolve())
    const running = runControl(fixture.channel, { signal: controller.signal })

    await vi.waitFor(() => expect(fixture.channel.write).toHaveBeenCalledOnce())
    controller.abort(reason)
    await expect(running).rejects.toBe(reason)
    expect(fixture.channel.requestClose).toHaveBeenCalledOnce()
    expect(fixture.channel.forceClose).not.toHaveBeenCalled()
  })

  it('propagates remote failure only after request EOF and settlement', async () => {
    const fixture = createChannel()
    const running = runControl(fixture.channel)
    await vi.waitFor(() => expect(fixture.channel.end).toHaveBeenCalledOnce())
    const error = new Error('PowerShell staging control failed')
    fixture.reject(error)
    await expect(running).rejects.toBe(error)
  })

  it('turns the command ceiling into bounded cancellation and settlement', async () => {
    vi.useFakeTimers()
    const fixture = createChannel()
    fixture.channel.requestClose.mockImplementation(() => fixture.resolve())
    const running = runControl(fixture.channel)
    const rejection = expect(running).rejects.toThrow(/timed out/i)

    await vi.advanceTimersByTimeAsync(
      SSH_RELAY_RUNTIME_WINDOWS_STAGING_CONTROL_LIMITS.commandTimeoutMs
    )
    await rejection
    expect(fixture.channel.requestClose).toHaveBeenCalledOnce()
    expect(fixture.channel.forceClose).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'win32')(
    'proves exclusive root ownership, Unicode directories, and owned cleanup in PowerShell 5.1',
    async () => {
      const parent = await mkdtemp(path.join(tmpdir(), 'orca-relay-win-control-'))
      const remoteRoot = path.join(parent, '测试 stage')
      const remoteParent = path.join(remoteRoot, 'bin')
      const remotePath = path.join(remoteParent, 'native')
      try {
        await runSshRelayRuntimeWindowsStagingControl({
          operation: 'create-root',
          remoteRoot,
          signal: new AbortController().signal,
          openChannel: openPowerShellChannel
        })
        const marker = path.join(remoteRoot, 'original.txt')
        await writeFile(marker, 'preserve')
        await expect(
          runSshRelayRuntimeWindowsStagingControl({
            operation: 'create-root',
            remoteRoot,
            signal: new AbortController().signal,
            openChannel: openPowerShellChannel
          })
        ).rejects.toThrow(/PowerShell staging control failed/i)
        expect(await readFile(marker, 'utf8')).toBe('preserve')

        await expect(
          runSshRelayRuntimeWindowsStagingControl({
            operation: 'create-directory',
            remoteRoot,
            remotePath,
            signal: new AbortController().signal,
            openChannel: openPowerShellChannel
          })
        ).rejects.toThrow(/PowerShell staging control failed/i)
        await runSshRelayRuntimeWindowsStagingControl({
          operation: 'create-directory',
          remoteRoot,
          remotePath: remoteParent,
          signal: new AbortController().signal,
          openChannel: openPowerShellChannel
        })
        await runSshRelayRuntimeWindowsStagingControl({
          operation: 'create-directory',
          remoteRoot,
          remotePath,
          signal: new AbortController().signal,
          openChannel: openPowerShellChannel
        })
        await runSshRelayRuntimeWindowsStagingControl({
          operation: 'remove-root',
          remoteRoot,
          signal: new AbortController().signal,
          openChannel: openPowerShellChannel
        })
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(parent, { recursive: true, force: true })
      }
    },
    30_000
  )
})

async function openPowerShellChannel(command: string): Promise<SshRelayRuntimeCommandFileChannel> {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/u)?.[1]
  if (!encoded) {
    throw new Error('PowerShell staging control command is not encoded')
  }
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }
  )
  let diagnostic = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    diagnostic = `${diagnostic}${chunk}`.slice(-4_096)
  })
  const settled = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`PowerShell staging control failed (${code ?? signal}): ${diagnostic}`))
      }
    })
  })
  return {
    write: (chunk: Buffer, callback: Callback) => {
      child.stdin.write(chunk, (error) => callback(error ?? undefined))
    },
    end: () => child.stdin.end(),
    settled,
    requestClose: () => child.kill(),
    forceClose: () => child.kill('SIGKILL')
  }
}
