/** #16432: PowerShell 5.1 hangs per empty-pipe read, not at a size threshold (32KiB still failed 15/120 under load). Verify SFTP first, PowerShell 7 next and bounded 5.1 last, with unique staging/publish names. */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SystemSshOperationLifecycle from './system-ssh-operation-lifecycle'

const { spawnSystemSshCommandMock, waitForChannelCloseSpy, runProcessMock } = vi.hoisted(() => ({
  spawnSystemSshCommandMock: vi.fn(),
  waitForChannelCloseSpy: vi.fn(),
  runProcessMock: vi.fn()
}))

vi.mock('./system-ssh-command', () => ({
  spawnSystemSshCommand: spawnSystemSshCommandMock
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock
}))

// Delegates to the real implementation; the spy only records whether each wait was given a bound.
vi.mock('./system-ssh-operation-lifecycle', async (importActual) => {
  const actual = (await importActual()) as typeof SystemSshOperationLifecycle
  waitForChannelCloseSpy.mockImplementation(actual.waitForChannelClose)
  return { ...actual, waitForChannelClose: waitForChannelCloseSpy }
})

import { uploadDirectoryViaSystemSsh } from './system-ssh-file-transfer'
import { uploadFileViaSystemSsh, writeBufferViaSystemSsh } from './system-ssh-file-binary-transfer'
import { WINDOWS_STAGED_WRITE_SUFFIX } from './system-ssh-windows-file-write'
import { waitForChannelClose } from './system-ssh-operation-lifecycle'
import * as windowsFileWrite from './system-ssh-windows-file-write'
import { getRemoteHostPlatform } from '../ssh-remote-platform'
import {
  clearWindowsRemoteWriteCapabilitiesForTests,
  getWindowsRemoteWriteCapabilities
} from './system-ssh-windows-write-capabilities'
import {
  explainWindowsPowerShellStdinFailure,
  WINDOWS_STDIN_WRITE_CHUNK_BYTES,
  WINDOWS_STDIN_WRITE_TIMEOUT_MS,
  writeWindowsRemoteFile
} from './system-ssh-windows-write-strategy'
import type { SshTarget } from '../../../shared/ssh-types'

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
const fileMode = (command: RecordedCommand): string | undefined =>
  /FileMode\]::(\w+)/.exec(command.script)?.[1]
const putLines = (): string[] =>
  sftpBatches.flatMap((batch) => batch.script.split('\n').filter((line) => line.startsWith('put ')))
const putDestination = (line: string): string => /put "(?:[^"]*)" "([^"]*)"/.exec(line)?.[1] ?? ''
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

function refusePwsh(): void {
  spawnSystemSshCommandMock.mockImplementation((_target: SshTarget, command: string) => {
    const spawnIndex = spawnSystemSshCommandMock.mock.calls.length - 1
    const executable = command.split(' ')[0] ?? ''
    return createFakeChannel((channel) => {
      commands.push({
        script: decodePowerShellCommand(command),
        executable,
        stdin: channel.written
      })
      setImmediate(() => {
        if (executable === 'pwsh.exe') {
          channel.stderr.write(
            "'pwsh.exe' is not recognized as an internal or external command,\noperable program or batch file."
          )
          channel.emit('close', 9009, null)
          return
        }
        channel.emit('close', spawnIndex === failAtSpawn ? 1 : 0, null)
      })
    })
  })
}

beforeEach(() => {
  commands.length = 0
  sftpBatches.length = 0
  failAtSpawn = -1
  failedWriteExit = 1
  failedWriteStderr = ''
  clearWindowsRemoteWriteCapabilitiesForTests()
  waitForChannelCloseSpy.mockClear()
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
  it('moves the payload without any remote process reading a stdin', async () => {
    const contents = Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 60 + 11, 0x64)
    const localPath = join(localDir, 'big.node')
    writeFileSync(localPath, contents)

    await uploadFileViaSystemSsh(target, localPath, `${remoteRoot}/big.node`, { hostPlatform })

    expect(fileWrites()).toHaveLength(0)
    expect(putLines()).toHaveLength(1)
    expect(sftpBatches).toHaveLength(1)
  })

  it('creates the parent chain and sends the payload in one round trip', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/a/b/relay.js`, {
      hostPlatform
    })

    expect(sftpBatches).toHaveLength(1)
    expect(sftpBatches[0]!.script.split('\n').filter(Boolean)).toEqual([
      '-mkdir "/C:/Users"',
      '-mkdir "/C:/Users/dev"',
      '-mkdir "/C:/Users/dev/.orca-remote"',
      '-mkdir "/C:/Users/dev/.orca-remote/a"',
      '-mkdir "/C:/Users/dev/.orca-remote/a/b"',
      expect.stringContaining('put ') as unknown as string
    ])
  })

  it('addresses the destination in the drive-rooted namespace sftp exposes', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    // Unnormalized Windows destinations can silently write a file named C and still exit 0.
    expect(putDestination(putLines()[0]!)).toMatch(
      /^\/C:\/Users\/dev\/\.orca-remote\/relay\.js\.orca-partial-[0-9a-f]{12}$/
    )
  })

  it('never lands a partial under the real name, and publishes by rename', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')
    const remotePath = `${remoteRoot}/relay.js`

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), remotePath, { hostPlatform })

    const destination = putDestination(putLines()[0]!)
    // Require a matched destination first; an empty regex result would trivially differ from the real path.
    expect(destination).toContain(WINDOWS_STAGED_WRITE_SUFFIX)
    expect(destination).not.toBe(`/C:${remotePath.slice(2)}`)
    const publish = commands.at(-1)!
    expect(publish.script).toContain(
      '[System.IO.File]::Replace($staging, $path, [NullString]::Value)'
    )
    expect(publish.script).not.toContain('OpenStandardInput')
  })

  it('never deletes the destination it is replacing', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    const publish = commands.at(-1)!
    // Delete-then-Move can destroy an existing file on failure; File.Replace must swap it atomically.
    expect(publish.script).not.toContain('[System.IO.File]::Delete($path)')
    expect(publish.script).toContain(
      '[System.IO.File]::Replace($staging, $path, [NullString]::Value)'
    )
    expect(publish.script).toContain(
      'catch [System.IO.FileNotFoundException] { [System.IO.File]::Move($staging, $path) }'
    )
  })

  it('gives every attempt its own staging name, so a retry cannot meet a predecessor lock', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })
    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    const [first, second] = putLines().map(putDestination)
    expect(first).toContain(WINDOWS_STAGED_WRITE_SUFFIX)
    expect(second).not.toBe(first)
  })

  it('enforces exclusive at the rename, where it is atomic', async () => {
    writeFileSync(join(localDir, 'import.bin'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'import.bin'), `${remoteRoot}/import.bin`, {
      hostPlatform,
      exclusive: true
    })

    const publish = commands.at(-1)!
    expect(publish.script).toContain('[System.IO.File]::Move($staging, $path)')
    expect(publish.script).not.toContain('[System.IO.File]::Delete($path)')
  })

  it('appends by concatenating the staged file, not by piping bytes to the remote', async () => {
    await writeBufferViaSystemSsh(target, `${remoteRoot}/log.bin`, Buffer.from('tail'), {
      hostPlatform,
      append: true
    })

    expect(fileWrites()).toHaveLength(0)
    const publish = commands.at(-1)!
    expect(publish.script).toContain('FileMode]::Append')
    expect(publish.script).toContain('$in.CopyTo($out)')
    expect(publish.script).toContain('[System.IO.File]::Delete($staging)')
  })

  it('still creates an empty artifact on the host', async () => {
    writeFileSync(join(localDir, 'empty.txt'), '')

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    expect(putLines()).toHaveLength(1)
    expect(commands.at(-1)!.script).toContain('[System.IO.File]::Move($staging, $path)')
  })

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

  it('creates upload directories over sftp rather than a PowerShell stdin batch', async () => {
    mkdirSync(join(localDir, 'node'), { recursive: true })
    writeFileSync(join(localDir, 'node', 'relay.js'), 'x')

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    // Observe a command first: some() on an empty list would pass this negative assertion.
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.some((command) => command.script.includes('StreamReader([Console]::'))).toBe(
      false
    )
    expect(sftpBatches[0]!.script).toContain('-mkdir "/C:/Users/dev/.orca-remote"')
  })

  it('sweeps the staged bytes when the publish is the thing that fails', async () => {
    writeFileSync(join(localDir, 'import.bin'), 'x')
    // Model publish refusal after payload staging, as on an exclusive conflict.
    spawnSystemSshCommandMock.mockImplementation((_target: SshTarget, command: string) => {
      const script = decodePowerShellCommand(command)
      return createFakeChannel((channel) => {
        commands.push({ script, executable: command.split(' ')[0] ?? '', stdin: channel.written })
        const failed = script.includes('::Move($staging, $path)')
        setImmediate(() => channel.emit('close', failed ? 1 : 0, null))
      })
    })

    await expect(
      uploadFileViaSystemSsh(target, join(localDir, 'import.bin'), `${remoteRoot}/import.bin`, {
        hostPlatform,
        exclusive: true
      })
    ).rejects.toThrow()

    const sweep = commands.at(-1)!
    expect(sweep.script).toContain('[System.IO.File]::Delete($staging)')
    // Contact loss never proves writer death; a locked staging file is tolerated.
    expect(sweep.script).toContain('$ErrorActionPreference = "SilentlyContinue"')
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

  it('does not let one unaddressable path become a verdict about the host', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    // UNC path refusal applies to this write; it says nothing about the host's SFTP support.
    await uploadFileViaSystemSsh(
      target,
      join(localDir, 'relay.js'),
      '//fileserver/share/relay.js',
      { hostPlatform }
    )

    expect(fileWrites().length).toBeGreaterThan(0)
    expect(sftpBatches).toHaveLength(0)
    // Never cache path refusal: a host-wide verdict would degrade later ordinary destinations too.
    expect(getWindowsRemoteWriteCapabilities(target).shouldTry('sftp-subsystem')).toBe(true)
  })

  it('keeps using sftp for the next file after one path it could not spell', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), '//fileserver/share/a.js', {
      hostPlatform
    })
    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/b.js`, {
      hostPlatform
    })

    expect(putLines()).toHaveLength(1)
    expect(putDestination(putLines()[0]!)).toContain('/C:/Users/dev/.orca-remote/b.js')
  })

  it('does not let a local filename sftp cannot quote become a verdict either', async () => {
    // POSIX clients allow a newline in a filename, and sftp's batch lexer would read it as the end
    // of one command and the start of another.
    const awkward = join(localDir, 'two\nlines.js')
    writeFileSync(awkward, 'x')

    await uploadFileViaSystemSsh(target, awkward, `${remoteRoot}/relay.js`, { hostPlatform })

    expect(fileWrites().length).toBeGreaterThan(0)
    expect(getWindowsRemoteWriteCapabilities(target).shouldTry('sftp-subsystem')).toBe(true)
  })

  it('translates the ssh argument list rather than passing it to a client that reads it differently', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform,
      disableControlMaster: true
    })

    const args = sftpBatches[0]!.args
    // sftp's `-T` does not exist, its `-p` preserves mtime, and its `-S` names a program to run.
    expect(args).not.toContain('-T')
    expect(args).not.toContain('-p')
    expect(args).not.toContain('-S')
    expect(args).toContain('ControlPath=none')
    expect(args).toContain('ServerAliveInterval=15')
  })
})

describe('Windows upload on a host with no sftp subsystem', () => {
  beforeEach(() => {
    refuseSftp()
  })

  it('creates a multi-directory tree, which the one-element case never exercised', async () => {
    mkdirSync(join(localDir, 'node', 'deep'), { recursive: true })
    writeFileSync(join(localDir, 'index.js'), 'a')
    writeFileSync(join(localDir, 'node', 'deep', 'x.js'), 'b')

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    const mkdir = commands.find((command) => command.script.includes('ConvertFrom-Json'))!
    // @() nests ConvertFrom-Json's array and joins its paths when stringified; string[] iterates them. Test multiple directories to expose it.
    expect(mkdir.script).toContain('[string[]]($json | ConvertFrom-Json)')
    expect(mkdir.script).not.toContain('@($json | ConvertFrom-Json)')
    const batch = JSON.parse(mkdir.stdin.toString('utf-8')) as string[]
    expect(batch.length).toBeGreaterThan(1)
  })

  it('falls back rather than failing the transfer', async () => {
    const contents = Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES + 5, 0x61)
    writeFileSync(join(localDir, 'relay.js'), contents)

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    expect(Buffer.concat(fileWrites().map((write) => write.stdin)).equals(contents)).toBe(true)
  })

  it('remembers the refusal, so a multi-file upload probes once', async () => {
    writeFileSync(join(localDir, 'a.js'), 'a')
    writeFileSync(join(localDir, 'b.js'), 'b')
    writeFileSync(join(localDir, 'c.js'), 'c')

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    expect(sftpBatches).toHaveLength(1)
  })

  it('does not spend a sweep round trip when sftp declined before moving any bytes', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    expect(commands.length).toBeGreaterThan(0)
    expect(commands.some((command) => command.script.includes('Delete($staging)'))).toBe(false)
  })

  it('prefers PowerShell 7, which reads a redirected stdin correctly', async () => {
    writeFileSync(join(localDir, 'relay.js'), Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3))

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    expect(fileWrites().map((write) => write.executable)).toEqual(['pwsh.exe'])
    expect(fileWrites()[0]!.stdin).toHaveLength(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3)
  })

  it('bounds every write when only Windows PowerShell 5.1 is available', async () => {
    refusePwsh()
    const contents = Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3 + 11, 0x64)
    writeFileSync(join(localDir, 'big.node'), contents)

    await uploadFileViaSystemSsh(target, join(localDir, 'big.node'), `${remoteRoot}/big.node`, {
      hostPlatform
    })

    const writes = fileWrites().filter((write) => write.executable === 'powershell.exe')
    expect(writes).toHaveLength(4)
    expect(Math.max(...writes.map((write) => write.stdin.length))).toBe(
      WINDOWS_STDIN_WRITE_CHUNK_BYTES
    )
    expect(Buffer.concat(writes.map((write) => write.stdin)).equals(contents)).toBe(true)
    expect(writes.map(fileMode)).toEqual(['Create', 'Append', 'Append', 'Append'])
    // A wedged 5.1 read never closes; require bounded waits and a nonempty call list so every() cannot pass vacuously.
    expect(waitForChannelCloseSpy.mock.calls.length).toBeGreaterThan(0)
    expect(
      waitForChannelCloseSpy.mock.calls.every((call) => call[2] === WINDOWS_STDIN_WRITE_TIMEOUT_MS)
    ).toBe(true)
  })

  it('remembers that PowerShell 7 is absent instead of re-probing per chunk', async () => {
    refusePwsh()
    writeFileSync(join(localDir, 'big.node'), Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3))

    await uploadFileViaSystemSsh(target, join(localDir, 'big.node'), `${remoteRoot}/big.node`, {
      hostPlatform
    })

    expect(fileWrites().filter((write) => write.executable === 'pwsh.exe')).toHaveLength(1)
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

  const capturedPowerShellMissingPwsh =
    "pwsh.exe : The term 'pwsh.exe' is not recognized as the name of a cmdlet, function, script file, or operable program. \r\nCheck the spelling of the name, or if a path was included, verify that the path is correct and try again.\r\nAt line:1 char:1\r\n+ pwsh.exe -NoProfile -NonInteractive -Command exit\r\n+ ~~~~~~~~\r\n    + CategoryInfo          : ObjectNotFound: (pwsh.exe:String) [], CommandNotFoundException\r\n    + FullyQualifiedErrorId : CommandNotFoundException"

  // Source-derived resource/layout controls; these are not captured localized Windows errors.
  const sourceDerivedLocalizedMissingPwsh = [
    'pwsh.exe : La commande est introuvable.',
    'Vérifiez le nom de la commande.',
    'À la ligne:1 caractère:1',
    '+ pwsh.exe -NoProfile -NonInteractive -EncodedCommand JABwAGEAdABoAA== ...',
    '+ ~~~~~~~~',
    '    + CategoryInfo : CommandNotFoundException — cible pwsh.exe, type String',
    '    + FullyQualifiedErrorId : CommandNotFoundException'
  ].join('\r\n')
  const sourceDerivedWrappedMissingPwsh = [
    'pwsh.exe : The term',
    "'pwsh.exe' is not recognized.",
    'At line:1 char:1',
    '+ pwsh.exe -NoProfile ',
    '-NonInteractive -EncodedCommand ',
    'JABwAGEAdABoAA== ...',
    '+ ~~~~~~~~',
    '    + CategoryInfo : ObjectNotFound: ',
    '(pwsh.exe:String) [], CommandNotFoundExcept',
    'ion',
    '    + FullyQualifiedErrorId : CommandNotFoundExcept',
    'ion'
  ].join('\r\n')

  it.each([
    "'missing-tool.exe' is not recognized as an internal or external command",
    `Access to the path 'relay.js' is denied.\n${capturedPowerShellMissingPwsh}`,
    `${capturedPowerShellMissingPwsh}\nAccess to the path 'relay.js' is denied.`,
    capturedPowerShellMissingPwsh.replaceAll('pwsh.exe', 'missing-tool.exe'),
    capturedPowerShellMissingPwsh.replace(/.*CategoryInfo.*\r?\n/, ''),
    capturedPowerShellMissingPwsh.replace('At line:', 'pwsh.exe : Another failure.\r\nAt line:'),
    capturedPowerShellMissingPwsh.replace('At line:', 'another.exe : Another failure.\r\nAt line:'),
    sourceDerivedLocalizedMissingPwsh.replace('cible pwsh.exe', 'cible relay-pwsh.exe.js'),
    sourceDerivedLocalizedMissingPwsh.replace('cible pwsh.exe', 'cible C:\\bin\\pwsh.exe'),
    sourceDerivedLocalizedMissingPwsh.replace('cible pwsh.exe', 'cible pwsh.exe-backup'),
    sourceDerivedLocalizedMissingPwsh.replace('type String', 'type FileInfo'),
    sourceDerivedWrappedMissingPwsh.replace('+ pwsh.exe', '+ missing-tool.exe'),
    `${sourceDerivedWrappedMissingPwsh}\n${capturedPowerShellMissingPwsh}`,
    `${sourceDerivedLocalizedMissingPwsh}\nAccess to the path 'relay.js' is denied.`,
    `Access to the path 'relay.js' is denied.\n${sourceDerivedLocalizedMissingPwsh}`,
    'CommandNotFoundException: missing-tool.exe',
    "Access to the path 'relay.js' is denied.\nCommandNotFoundException: pwsh.exe",
    "Access to the path 'relay.js' is denied.\n'pwsh.exe' is not recognized as an internal or external command"
  ])(
    'does not mark PowerShell 7 absent when its script reports another missing command: %s',
    async (stderr) => {
      writeFileSync(join(localDir, 'relay.js'), 'x')
      failAtSpawn = 0
      failedWriteStderr = stderr

      await expect(
        uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
          hostPlatform
        })
      ).rejects.toThrow('failed (exit 1)')

      expect(fileWrites().map((write) => write.executable)).toEqual(['pwsh.exe'])
      expect(getWindowsRemoteWriteCapabilities(target).shouldTry('pwsh')).toBe(true)
      expect(commands.some((command) => command.script.includes('::Move('))).toBe(false)
    }
  )

  it.each([
    [9009, ''],
    [1, "'pwsh.exe' is not recognized as an internal or external command"],
    [1, 'CommandNotFoundException: pwsh.exe'],
    [
      1,
      "'pwsh.exe' is not recognized as an internal or external command,\r\noperable program or batch file."
    ],
    [1, capturedPowerShellMissingPwsh]
  ])('falls back on an actual missing PowerShell 7 signal: %s %s', async (exit, stderr) => {
    writeFileSync(join(localDir, 'relay.js'), Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3))
    failAtSpawn = 0
    failedWriteExit = exit
    failedWriteStderr = stderr

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    expect(fileWrites().map((write) => write.executable)).toEqual([
      'pwsh.exe',
      'powershell.exe',
      'powershell.exe',
      'powershell.exe'
    ])
    expect(getWindowsRemoteWriteCapabilities(target).shouldTry('pwsh')).toBe(false)
    expect(commands.some((command) => command.script.includes('::Move('))).toBe(true)
  })

  it.each([
    sourceDerivedLocalizedMissingPwsh,
    sourceDerivedWrappedMissingPwsh,
    sourceDerivedLocalizedMissingPwsh.replace(' -NonInteractive', '\r\n -NonInteractive')
  ])(
    'falls back on a source-derived localized or wrapped missing-pwsh record: %s',
    async (stderr) => {
      writeFileSync(join(localDir, 'relay.js'), 'x')
      failAtSpawn = 0
      failedWriteStderr = stderr

      await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
        hostPlatform
      })

      expect(fileWrites().map((write) => write.executable)).toEqual(['pwsh.exe', 'powershell.exe'])
      expect(getWindowsRemoteWriteCapabilities(target).shouldTry('pwsh')).toBe(false)
      expect(commands.some((command) => command.script.includes('::Move('))).toBe(true)
    }
  )

  it.each([
    'relay-CommandNotFoundException.js',
    'is not recognized as an internal or external command.js'
  ])('propagates a timeout whose filename resembles a missing command: %s', async (file) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const remotePath = `${remoteRoot}/${file}`
    writeFileSync(join(localDir, file), 'x')
    let noteWriteStarted: () => void = () => {}
    const writeStarted = new Promise<void>((resolve) => {
      noteWriteStarted = resolve
    })
    spawnSystemSshCommandMock.mockImplementation((_target: SshTarget, command: string) => {
      const executable = command.split(' ')[0] ?? ''
      return createFakeChannel((channel) => {
        commands.push({
          script: decodePowerShellCommand(command),
          executable,
          stdin: channel.written
        })
        if (executable !== 'pwsh.exe') {
          setImmediate(() => channel.emit('close', 0, null))
        } else {
          noteWriteStarted()
        }
      })
    })
    try {
      const result = expect(
        uploadFileViaSystemSsh(target, join(localDir, file), remotePath, { hostPlatform })
      ).rejects.toThrow('timed out')
      await writeStarted
      await vi.advanceTimersByTimeAsync(WINDOWS_STDIN_WRITE_TIMEOUT_MS + 1)
      await result

      expect(fileWrites().map((write) => write.executable)).toEqual(['pwsh.exe'])
      expect(getWindowsRemoteWriteCapabilities(target).shouldTry('pwsh')).toBe(true)
      expect(commands.some((command) => command.script.includes('::Move('))).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    'relay-CommandNotFoundException.js',
    'is not recognized as an internal or external command.js'
  ])('propagates a short source whose filename resembles a missing command: %s', async (file) => {
    await expect(
      writeWindowsRemoteFile(
        target,
        `${remoteRoot}/${file}`,
        {
          totalBytes: 1,
          readChunk: async () => Buffer.alloc(0),
          withLocalFile: async (send) => send(join(localDir, file))
        },
        {}
      )
    ).rejects.toThrow('Source ran short')

    expect(fileWrites()).toHaveLength(0)
    expect(getWindowsRemoteWriteCapabilities(target).shouldTry('pwsh')).toBe(true)
    expect(commands.some((command) => command.script.includes('::Move('))).toBe(false)
  })
})

describe('last-resort Windows PowerShell failure reporting', () => {
  it('names the host limitation and its remedy, not just the timeout', () => {
    const timeout = new Error('write C:/x at offset 0 timed out after 60000ms with no response')

    const explained = explainWindowsPowerShellStdinFailure(timeout) as Error

    // Identify the host-side remedy; a generic timeout would suggest an ineffective network retry.
    expect(explained.message).toContain('Windows PowerShell 5.1')
    expect(explained.message).toContain('Subsystem sftp sftp-server.exe')
    expect(explained.cause).toBe(timeout)
  })

  it('leaves a real failure alone, so a permission error is not reported as a host limitation', () => {
    const denied = new Error('write C:/x at offset 0 failed (exit 1): Access to the path is denied')

    expect(explainWindowsPowerShellStdinFailure(denied)).toBe(denied)
  })
})

describe('waitForChannelClose bounding', () => {
  it('fails a remote that accepts stdin and never closes, instead of waiting forever', async () => {
    vi.useFakeTimers()
    try {
      const channel = createFakeChannel(() => {})
      const settled = vi.fn()
      const promise = waitForChannelClose(channel as never, 'windows relay upload', 1_000)
      promise.then(settled, settled)

      await vi.advanceTimersByTimeAsync(999)
      expect(settled).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(2)
      await expect(promise).rejects.toThrow(/timed out after 1000ms with no response/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves an unbounded wait unbounded when no timeout is asked for', async () => {
    vi.useFakeTimers()
    try {
      const channel = createFakeChannel(() => {})
      const settled = vi.fn()
      void waitForChannelClose(channel as never, 'posix write').then(settled, settled)

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(settled).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
