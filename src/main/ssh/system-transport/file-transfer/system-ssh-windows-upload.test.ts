/** #16432: PowerShell 5.1 hangs per empty-pipe read, not at a size threshold (32KiB still failed 15/120 under load). Verify SFTP first, PowerShell 7 next and bounded 5.1 last, with unique staging/publish names. */
import { EventEmitter } from 'node:events'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnSystemSshCommandMock, runProcessMock } = vi.hoisted(() => ({
  spawnSystemSshCommandMock: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('../system-ssh-command', () => ({
  spawnSystemSshCommand: spawnSystemSshCommandMock
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))

import { uploadFileViaSystemSsh, writeBufferViaSystemSsh } from './system-ssh-file-binary-transfer'
import { WINDOWS_STAGED_WRITE_SUFFIX } from './system-ssh-windows-file-write'

import * as windowsFileWrite from './system-ssh-windows-file-write'
import { getRemoteHostPlatform } from '../../remote-host/ssh-remote-platform'
import {
  clearWindowsRemoteWriteCapabilitiesForTests,
  getWindowsRemoteWriteCapabilities
} from './system-ssh-windows-write-capabilities'
import { WINDOWS_STDIN_WRITE_CHUNK_BYTES } from './system-ssh-windows-write-strategy'
import type { SshTarget } from '../../../../shared/ssh-types'

type FakeChannel = EventEmitter & {
  stdin: Writable
  stderr: PassThrough
  close: () => void
  written: Buffer
}

const target = {
  id: 'win-1',
  host: 'win.example',
  username: 'dev',
  port: 22
} as unknown as SshTarget
const hostPlatform = getRemoteHostPlatform('win32-x64')
const remoteRoot = 'C:/Users/dev/.orca-remote'

function decodePowerShellCommand(command: string): string {
  const encoded = /-EncodedCommand (\S+)/.exec(command)?.[1]
  return encoded === undefined ? command : Buffer.from(encoded, 'base64').toString('utf16le')
}

function createFakeChannel(onEnd: (channel: FakeChannel) => void): FakeChannel {
  const channel = new EventEmitter() as FakeChannel
  channel.written = Buffer.alloc(0)
  channel.stderr = new PassThrough()
  channel.stdin = new Writable({
    write(chunk, _encoding, callback) {
      channel.written = Buffer.concat([channel.written, Buffer.from(chunk)])
      callback()
    },
    final(callback) {
      callback()
      onEnd(channel)
    }
  })
  channel.close = () => channel.emit('close', null, 'SIGTERM')
  return channel
}

type RecordedCommand = { script: string; executable: string; stdin: Buffer }
type RecordedSftpBatch = { args: string[]; script: string }

const sftpBatches: RecordedSftpBatch[] = []
const commands: RecordedCommand[] = []
let failAtSpawn = -1
let failedWriteExit = 1
let failedWriteStderr = ''
let localDir: string

const fileWrites = (): RecordedCommand[] =>
  commands.filter((command) => command.script.includes('OpenStandardInput'))
const writtenPath = (command: RecordedCommand): string =>
  /\$path = '((?:[^']|'')*)'/.exec(command.script)?.[1]?.replace(/''/g, "'") ?? ''

const putSource = (line: string): string => /put "([^"]*)"/.exec(line)?.[1] ?? ''

function acceptSftp(): void {
  runProcessMock.mockImplementation(
    async (spec: { args: string[]; input: string; program: string }) => {
      const script = spec.input
      sftpBatches.push({ args: spec.args, script })
      // Model the real client: `put` copies the local file, so read it while it still exists.
      for (const line of script.split('\n').filter((entry) => entry.startsWith('put '))) {
        await readFile(putSource(line))
      }
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    }
  )
}

function refuseSftp(): void {
  runProcessMock.mockImplementation(async (spec: { args: string[]; input: string }) => {
    sftpBatches.push({ args: spec.args, script: spec.input })
    return {
      code: 255,
      signal: null,
      stdout: '',
      stderr: 'subsystem request failed on channel 0\nConnection closed',
      timedOut: false
    }
  })
}

beforeEach(() => {
  commands.length = 0
  sftpBatches.length = 0
  failAtSpawn = -1
  failedWriteExit = 1
  failedWriteStderr = ''
  clearWindowsRemoteWriteCapabilitiesForTests()
  localDir = mkdtempSync(join(tmpdir(), 'orca-win-upload-'))
  process.env.ORCA_SYSTEM_SFTP_PATH = '/usr/bin/sftp'
  runProcessMock.mockReset()
  acceptSftp()
  spawnSystemSshCommandMock.mockReset()
  spawnSystemSshCommandMock.mockImplementation((_target: SshTarget, command: string) => {
    const spawnIndex = spawnSystemSshCommandMock.mock.calls.length - 1
    return createFakeChannel((channel) => {
      commands.push({
        script: decodePowerShellCommand(command),
        executable: command.split(' ')[0] ?? '',
        stdin: channel.written
      })
      setImmediate(() => {
        if (spawnIndex === failAtSpawn) {
          channel.stderr.write(failedWriteStderr)
          channel.emit('close', failedWriteExit, null)
        } else {
          channel.emit('close', 0, null)
        }
      })
    })
  })
})

afterEach(async () => {
  delete process.env.ORCA_SYSTEM_SFTP_PATH
  await rm(localDir, { recursive: true, force: true })
})

describe('Windows upload over sftp', () => {
  it('writes a buffer through a 0600 temp file that does not outlive the transfer', async () => {
    const seen: { path: string; contents: Buffer; mode: number }[] = []
    runProcessMock.mockImplementation(async (spec: { args: string[]; input: string }) => {
      sftpBatches.push({ args: spec.args, script: spec.input })
      for (const line of spec.input.split('\n').filter((entry) => entry.startsWith('put '))) {
        const path = putSource(line)
        seen.push({
          path,
          contents: await readFile(path),
          mode: (await stat(path)).mode & 0o777
        })
      }
      return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    })

    await writeBufferViaSystemSsh(target, `${remoteRoot}/version`, Buffer.from('1.2.3'), {
      hostPlatform
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]!.contents.toString()).toBe('1.2.3')
    // Repository payloads in shared temp directories must be private from creation.
    expect(seen[0]!.mode).toBe(0o600)
    await expect(readFile(seen[0]!.path)).rejects.toThrow()
  })

  it('reports a cancelled transfer as an abort, not as a failed one', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')
    const controller = new AbortController()
    // runProcess reports cancellation as nonzero exit; check signal before classifying it as transfer failure.
    runProcessMock.mockImplementation(async (spec: { args: string[]; input: string }) => {
      sftpBatches.push({ args: spec.args, script: spec.input })
      controller.abort()
      return { code: 255, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: false }
    })

    let error: Error | undefined
    try {
      await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
        hostPlatform,
        signal: controller.signal
      })
    } catch (thrown) {
      error = thrown as Error
    }

    expect(error?.name).toBe('AbortError')
    expect(error?.message).not.toContain('sftp batch failed')
    // Cancellation proves no host limitation and must not trigger the defective fallback.
    expect(getWindowsRemoteWriteCapabilities(target).shouldTry('sftp-subsystem')).toBe(true)
    expect(fileWrites()).toHaveLength(0)
  })
})

describe('Windows upload on a host with no sftp subsystem', () => {
  beforeEach(() => {
    refuseSftp()
  })

  it('falls back rather than failing the transfer', async () => {
    const contents = Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES + 5, 0x61)
    writeFileSync(join(localDir, 'relay.js'), contents)

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    expect(Buffer.concat(fileWrites().map((write) => write.stdin)).equals(contents)).toBe(true)
  })

  it('leaves no truncated file under the real name when a chunk fails mid-file', async () => {
    writeFileSync(join(localDir, 'relay.js'), Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3))
    failAtSpawn = 0

    await expect(
      uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
        hostPlatform
      })
    ).rejects.toThrow()

    expect(fileWrites().length).toBeGreaterThan(0)
    expect(fileWrites().map(writtenPath)).not.toContain(`${remoteRoot}/relay.js`)
    expect(commands.some((command) => command.script.includes('::Move('))).toBe(false)
  })

  it.each([
    ['relay.js', 'aabb9009eeff'],
    ['relay-9009.js', 'aabbccddeeff'],
    ['relay-CommandNotFoundException.js', 'aabbccddeeff'],
    ['is not recognized as an internal or external command.js', 'aabbccddeeff']
  ])('propagates a failed write whose path contains absence-like text: %s', async (file, nonce) => {
    const remotePath = `${remoteRoot}/${file}`
    const staging = vi
      .spyOn(windowsFileWrite, 'makeWindowsStagingPath')
      .mockImplementation((path) => `${path}${WINDOWS_STAGED_WRITE_SUFFIX}-${nonce}`)
    writeFileSync(join(localDir, file), Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3))
    failAtSpawn = 0
    try {
      await expect(
        uploadFileViaSystemSsh(target, join(localDir, file), remotePath, { hostPlatform })
      ).rejects.toThrow('failed (exit 1)')

      expect(fileWrites().map((write) => write.executable)).toEqual(['pwsh.exe'])
      expect(getWindowsRemoteWriteCapabilities(target).shouldTry('pwsh')).toBe(true)
      expect(commands.some((command) => command.script.includes('::Move('))).toBe(false)
    } finally {
      staging.mockRestore()
    }
  })

  it.each([
    'relay-CommandNotFoundException.js',
    'is not recognized as an internal or external command.js'
  ])('propagates a write-denied stderr naming an absence-like filename: %s', async (file) => {
    const remotePath = `${remoteRoot}/${file}`
    writeFileSync(join(localDir, file), 'x')
    failAtSpawn = 0
    failedWriteStderr = `Access to the path '${remotePath}' is denied.`

    await expect(
      uploadFileViaSystemSsh(target, join(localDir, file), remotePath, { hostPlatform })
    ).rejects.toThrow('Access to the path')

    expect(fileWrites().map((write) => write.executable)).toEqual(['pwsh.exe'])
    expect(getWindowsRemoteWriteCapabilities(target).shouldTry('pwsh')).toBe(true)
    expect(commands.some((command) => command.script.includes('::Move('))).toBe(false)
  })
})
