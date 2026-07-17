import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  openSshRelayRuntimeWindowsFileDestination,
  SSH_RELAY_RUNTIME_WINDOWS_FILE_DESTINATION_LIMITS
} from './ssh-relay-runtime-windows-file-destination'

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

function decodeHeader(frame: Buffer) {
  const pathLength = frame.readUInt32LE(8)
  return {
    magic: frame.subarray(0, 8).toString('ascii'),
    pathLength,
    expectedSize: frame.readBigUInt64LE(12),
    remotePath: frame.subarray(20, 20 + pathLength).toString('utf8')
  }
}

const completionFrame = Buffer.from('ORCAEND1', 'ascii')

function decodePowerShellCommand(command: string): string {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/u)?.[1]
  if (!encoded) {
    throw new Error('PowerShell receiver command is not encoded')
  }
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

function openDestination(
  channel: ReturnType<typeof createChannel>['channel'],
  overrides: Partial<Parameters<typeof openSshRelayRuntimeWindowsFileDestination>[0]> = {}
) {
  return openSshRelayRuntimeWindowsFileDestination({
    remotePath: 'C:/Users/测试/.orca-remote/stage/bin/node.exe',
    expectedSize: 65_537,
    signal: new AbortController().signal,
    openChannel: vi.fn(async () => channel),
    ...overrides
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SSH relay runtime Windows system-SSH file destination', () => {
  it('opens one fixed receiver and awaits an exact bounded binary header', async () => {
    const { channel, resolve } = createChannel()
    let headerCallback: Callback | undefined
    channel.write.mockImplementationOnce((_chunk, callback) => {
      headerCallback = callback
    })
    const openChannel = vi.fn(async (_command: string, _signal: AbortSignal) => channel)
    let opened = false
    const opening = openDestination(channel, { openChannel }).then((destination) => {
      opened = true
      return destination
    })

    await vi.waitFor(() => expect(channel.write).toHaveBeenCalledOnce())
    expect(opened).toBe(false)
    expect(openChannel).toHaveBeenCalledOnce()
    const command = openChannel.mock.calls[0]?.[0] ?? ''
    expect(command).toMatch(/^powershell\.exe .* -EncodedCommand [A-Za-z0-9+/=]+$/u)
    expect(command).not.toContain('测试')
    expect(command).not.toContain('65_537')
    const script = decodePowerShellCommand(command)
    expect(script).toContain('[Console]::OpenStandardInput()')
    expect(script).toContain('[IO.FileMode]::CreateNew')
    expect(script).toContain('[IO.FileShare]::None')
    expect(script).toContain('New-Object byte[] 4096')
    expect(script).toContain("-ne 'ORCAEND1'")
    expect(script).not.toContain('$inputStream.ReadByte()')
    for (const forbidden of ['ReadToEnd', 'CopyTo(', 'FromBase64String', 'ConvertFrom-Json']) {
      expect(script).not.toContain(forbidden)
    }

    const frame = channel.write.mock.calls[0]?.[0]
    expect(Buffer.isBuffer(frame)).toBe(true)
    expect(frame.length).toBeLessThanOrEqual(
      SSH_RELAY_RUNTIME_WINDOWS_FILE_DESTINATION_LIMITS.maximumHeaderBytes
    )
    expect(decodeHeader(frame)).toEqual({
      magic: 'ORCARLY1',
      pathLength: Buffer.byteLength('C:/Users/测试/.orca-remote/stage/bin/node.exe'),
      expectedSize: 65_537n,
      remotePath: 'C:/Users/测试/.orca-remote/stage/bin/node.exe'
    })

    headerCallback?.()
    const destination = await opening
    await destination.write(Buffer.alloc(65_537, 7))
    const closing = destination.close()
    const expectedWrites =
      Math.ceil(65_537 / SSH_RELAY_RUNTIME_WINDOWS_FILE_DESTINATION_LIMITS.maximumPipeWriteBytes) +
      2
    await vi.waitFor(() => expect(channel.write).toHaveBeenCalledTimes(expectedWrites))
    expect(channel.write.mock.calls.at(-1)?.[0]).toEqual(completionFrame)
    resolve()
    await closing
  })

  it('subdivides a borrowed source chunk into sequential zero-copy pipe writes', async () => {
    const { channel, resolve } = createChannel()
    const callbacks: Callback[] = []
    channel.write.mockImplementation((_chunk, callback) => {
      if (channel.write.mock.calls.length === 1) {
        callback()
        return
      }
      callbacks.push(callback)
    })
    const maximum = SSH_RELAY_RUNTIME_WINDOWS_FILE_DESTINATION_LIMITS.maximumPipeWriteBytes
    const payload = Buffer.alloc(maximum * 2 + 3, 9)
    const destination = await openDestination(channel, { expectedSize: payload.length })
    let settled = false
    const writing = destination.write(payload).then(() => {
      settled = true
    })

    await vi.waitFor(() => expect(channel.write).toHaveBeenCalledTimes(2))
    expect(channel.write.mock.calls[1]?.[0]).toHaveLength(maximum)
    expect(channel.write.mock.calls[1]?.[0].buffer).toBe(payload.buffer)
    callbacks.shift()?.()
    await vi.waitFor(() => expect(channel.write).toHaveBeenCalledTimes(3))
    expect(settled).toBe(false)
    expect(channel.write.mock.calls[2]?.[0]).toHaveLength(maximum)
    expect(channel.write.mock.calls[2]?.[0].buffer).toBe(payload.buffer)
    callbacks.shift()?.()
    await vi.waitFor(() => expect(channel.write).toHaveBeenCalledTimes(4))
    expect(settled).toBe(false)
    expect(channel.write.mock.calls[3]?.[0]).toHaveLength(3)
    expect(channel.write.mock.calls[3]?.[0].buffer).toBe(payload.buffer)
    callbacks.shift()?.()
    await writing
    expect(settled).toBe(true)
    const closing = destination.close()
    await vi.waitFor(() => expect(channel.write).toHaveBeenCalledTimes(5))
    callbacks.shift()?.()
    resolve()
    await closing
  })

  it.each([
    ['', 1],
    ['relative/file', 1],
    ['C:/', 1],
    ['C:/owned/../file', 1],
    ['C:/owned/report.txt:stream', 1],
    ['C:/owned/NUL', 1],
    ['C:/owned/file\nnext', 1],
    ['C:/owned/file', -1],
    ['C:/owned/file', Number.MAX_SAFE_INTEGER + 1],
    ['C:/owned/file', 1.5]
  ])('rejects hostile path %j or size %j before channel open', async (remotePath, expectedSize) => {
    const { channel } = createChannel()
    const openChannel = vi.fn(async () => channel)

    await expect(
      openDestination(channel, { remotePath, expectedSize, openChannel })
    ).rejects.toThrow(/invalid/i)
    expect(openChannel).not.toHaveBeenCalled()
  })

  it('joins a failed header write with bounded channel cleanup', async () => {
    const { channel, resolve } = createChannel()
    channel.write.mockImplementationOnce((_chunk, callback) => {
      callback(new Error('header rejected'))
    })
    channel.requestClose.mockImplementation(() => resolve())

    await expect(openDestination(channel)).rejects.toThrow('header rejected')
    expect(channel.requestClose).toHaveBeenCalledOnce()
    expect(channel.forceClose).not.toHaveBeenCalled()
  })

  it('settles retained-header cancellation before rejecting open', async () => {
    const { channel, resolve } = createChannel()
    const controller = new AbortController()
    const reason = new Error('cancelled retained Windows header')
    channel.write.mockImplementationOnce(() => {})
    channel.requestClose.mockImplementation(() => resolve())
    const opening = openDestination(channel, { signal: controller.signal })

    await vi.waitFor(() => expect(channel.write).toHaveBeenCalledOnce())
    controller.abort(reason)
    await expect(opening).rejects.toBe(reason)
    expect(channel.requestClose).toHaveBeenCalledOnce()
    expect(channel.forceClose).not.toHaveBeenCalled()
  })

  it('propagates receiver failure only after framed completion and remote settlement', async () => {
    const { channel, reject } = createChannel()
    const destination = await openDestination(channel, { expectedSize: 0 })
    const closing = destination.close()

    await vi.waitFor(() => expect(channel.end).toHaveBeenCalledOnce())
    expect(channel.write.mock.calls[1]?.[0]).toEqual(completionFrame)
    reject(new Error('receiver rejected completion frame'))
    await expect(closing).rejects.toThrow('receiver rejected completion frame')
  })

  it.each([
    ['short', 2, Buffer.from([1])],
    ['long', 1, Buffer.from([1, 2])]
  ])('rejects a %s payload locally and aborts its channel', async (_kind, expectedSize, bytes) => {
    const { channel, resolve } = createChannel()
    channel.requestClose.mockImplementation(() => resolve())
    const destination = await openDestination(channel, { expectedSize })

    if (bytes.length > expectedSize) {
      await expect(destination.write(bytes)).rejects.toThrow(/payload size mismatch/i)
    } else {
      await destination.write(bytes)
      await expect(destination.close()).rejects.toThrow(/payload size mismatch/i)
    }
    expect(channel.requestClose).toHaveBeenCalledOnce()
    expect(channel.forceClose).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform !== 'win32')(
    'proves PowerShell 5.1 binary fidelity, exclusive collision, and exact-size rejection',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'orca-relay-win-file-'))
      try {
        const payload = Buffer.from([0, 13, 10, 255, 128, 1, 2, 3, 0, 254])
        const exactPath = path.join(root, '测试 payload.bin')
        const exact = await openSshRelayRuntimeWindowsFileDestination({
          remotePath: exactPath,
          expectedSize: payload.length,
          signal: new AbortController().signal,
          openChannel: openPowerShellChannel
        })
        await exact.write(payload.subarray(0, 3))
        await exact.write(payload.subarray(3))
        await exact.close()
        expect(await readFile(exactPath)).toEqual(payload)

        const collisionPath = path.join(root, 'collision.bin')
        await writeFile(collisionPath, 'original')
        const collision = await openSshRelayRuntimeWindowsFileDestination({
          remotePath: collisionPath,
          expectedSize: 0,
          signal: new AbortController().signal,
          openChannel: openPowerShellChannel
        })
        await expect(collision.close()).rejects.toThrow(/PowerShell receiver failed/i)
        expect(await readFile(collisionPath, 'utf8')).toBe('original')

        for (const [name, expectedSize, bytes] of [
          ['early.bin', 2, Buffer.from([1])],
          ['extra.bin', 1, Buffer.from([1, 2])]
        ] as const) {
          const remotePath = path.join(root, name)
          const destination = await openSshRelayRuntimeWindowsFileDestination({
            remotePath,
            expectedSize,
            signal: new AbortController().signal,
            openChannel: openPowerShellChannel
          })
          if (bytes.length > expectedSize) {
            await expect(destination.write(bytes)).rejects.toThrow(/payload size mismatch/i)
          } else {
            await destination.write(bytes)
            await expect(destination.close()).rejects.toThrow(/payload size mismatch/i)
          }
          await expect(readFile(remotePath)).rejects.toMatchObject({ code: 'ENOENT' })
        }
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    30_000
  )
})

async function openPowerShellChannel(command: string) {
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)$/u)?.[1]
  if (!encoded) {
    throw new Error('PowerShell receiver command is not encoded')
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
        reject(new Error(`PowerShell receiver failed (${code ?? signal}): ${diagnostic}`))
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
