/**
 * #16432. The original fix chunked the payload because the constraint was believed to be a ~50KB
 * cmd.exe stdin ceiling. Re-measured on Windows 11 26200.9168 / OpenSSH_for_Windows_10.0p2, it is
 * not a size limit and not cmd.exe's: a read on Windows PowerShell 5.1's redirected-stdin handle
 * over a non-pty ssh exec can die permanently when it finds the stream momentarily empty, taking
 * both the remaining data and the EOF with it. It is probabilistic per such read — identical 2MB
 * payloads died at 167936, 270336 and 372736 — so a 32KB chunk still failed 15 times in 120 under
 * load, while `findstr` took 2,016,000 bytes through one exec on the same host.
 *
 * So the covering property is no longer "every write is small". It is "the bytes do not cross a
 * remote process's stdin at all": sftp first, PowerShell 7 next, and Windows PowerShell 5.1 last,
 * bounded and loud. The staging-and-rename discipline is kept on every path, with a unique staging
 * name per attempt so a retry never meets a predecessor's lock.
 */
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

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))

// Delegates to the real implementation; the spy only records whether each wait was given a bound.
vi.mock('./system-ssh-operation-lifecycle', async (importActual) => {
  const actual = (await importActual()) as typeof SystemSshOperationLifecycle
  waitForChannelCloseSpy.mockImplementation(actual.waitForChannelClose)
  return { ...actual, waitForChannelClose: waitForChannelCloseSpy }
})

import { uploadDirectoryViaSystemSsh } from './system-ssh-file-transfer'
import {
  uploadFileViaSystemSsh,
  WINDOWS_STAGED_WRITE_SUFFIX,
  WINDOWS_STDIN_WRITE_CHUNK_BYTES,
  WINDOWS_STDIN_WRITE_TIMEOUT_MS,
  writeBufferViaSystemSsh
} from './system-ssh-file-binary-transfer'
import { waitForChannelClose } from './system-ssh-operation-lifecycle'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import {
  clearWindowsRemoteWriteCapabilitiesForTests,
  getWindowsRemoteWriteCapabilities
} from './system-ssh-windows-write-capabilities'
import { explainWindowsPowerShellStdinFailure } from './system-ssh-windows-write-strategy'
import type { SshTarget } from '../../shared/ssh-types'

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

/** Recover the script from `powershell.exe ... -EncodedCommand <base64 utf-16le>`. */
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
/** Index of the exec that should report a non-zero exit, to model a chunk failing mid-file. */
let failAtSpawn = -1
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

/** Makes every sftp batch succeed, recording what it was asked to do. */
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

/** Models a host whose sshd has no `Subsystem sftp` line. */
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

/** Models a host with no PowerShell 7, which cmd.exe reports as an unrecognized command. */
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
      setImmediate(() =>
        spawnIndex === failAtSpawn ? channel.emit('close', 1, null) : channel.emit('close', 0, null)
      )
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

    // The defect is a remote stdin read; the fix is that there is not one.
    expect(fileWrites()).toHaveLength(0)
    expect(putLines()).toHaveLength(1)
    // One transfer, not 61 execs: the whole point of the change.
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

    // A backslash destination silently writes a file named `C` and still exits 0, so the leading
    // slash and forward separators are correctness, not style.
    expect(putDestination(putLines()[0]!)).toMatch(
      /^\/C:\/Users\/dev\/\.orca-remote\/relay\.js\.orca-partial-[0-9a-f]{12}$/
    )
  })

  it('never lands a partial under the real name, and publishes by rename', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')
    const remotePath = `${remoteRoot}/relay.js`

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), remotePath, { hostPlatform })

    const destination = putDestination(putLines()[0]!)
    // Assert the positive first: an unmatched regex yields '', which would satisfy the `not.toBe`
    // below without this test ever having seen a destination.
    expect(destination).toContain(WINDOWS_STAGED_WRITE_SUFFIX)
    expect(destination).not.toBe(`/C:${remotePath.slice(2)}`)
    const publish = commands.at(-1)!
    expect(publish.script).toContain(
      '[System.IO.File]::Replace($staging, $path, [NullString]::Value)'
    )
    // The publish reads the staged file, never a pipe, so it is safe on PowerShell 5.1.
    expect(publish.script).not.toContain('OpenStandardInput')
  })

  it('never deletes the destination it is replacing', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    const publish = commands.at(-1)!
    // Delete-then-move destroys the user's existing file outright if the move then fails, and
    // exposes a window where a reader sees no file at all — worse than the truncated partial the
    // staging discipline exists to prevent. `File.Replace` is the atomic swap.
    expect(publish.script).not.toContain('[System.IO.File]::Delete($path)')
    expect(publish.script).toContain(
      '[System.IO.File]::Replace($staging, $path, [NullString]::Value)'
    )
    // An absent destination cannot be Replaced, so that case falls back to a plain Move.
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
    // Losing contact is not evidence the previous writer died, so the name must not be reused.
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
    // The payload can be repository content and tmpdir is world-readable on every platform, so the
    // window between write and upload must not be group- or world-readable.
    expect(seen[0]!.mode).toBe(0o600)
    await expect(readFile(seen[0]!.path)).rejects.toThrow()
  })

  it('creates upload directories over sftp rather than a PowerShell stdin batch', async () => {
    mkdirSync(join(localDir, 'node'), { recursive: true })
    writeFileSync(join(localDir, 'node', 'relay.js'), 'x')

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    // Anchor on a non-empty observation: `some` is false of an empty list, so this would pass even
    // if no command had been recorded at all.
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.some((command) => command.script.includes('StreamReader([Console]::'))).toBe(
      false
    )
    expect(sftpBatches[0]!.script).toContain('-mkdir "/C:/Users/dev/.orca-remote"')
  })

  it('sweeps the staged bytes when the publish is the thing that fails', async () => {
    writeFileSync(join(localDir, 'import.bin'), 'x')
    // An exclusive conflict is the ordinary way to get here: the payload is on the host, and the
    // rename that would have given it a name refuses.
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
    // Tolerated, not asserted: the previous writer may still hold the file, and losing contact is
    // not evidence it died.
    expect(sweep.script).toContain('$ErrorActionPreference = "SilentlyContinue"')
  })

  it('reports a cancelled transfer as an abort, not as a failed one', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')
    const controller = new AbortController()
    // runProcess reports the kill as a non-zero exit rather than throwing, so without checking the
    // signal first a user pressing cancel is indistinguishable from the transfer genuinely failing.
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
    // A cancel is also not evidence about the host, so it must not send later writes to the slow
    // path, and must not fall through to the defective reader now.
    expect(getWindowsRemoteWriteCapabilities(target).shouldTry('sftp-subsystem')).toBe(true)
    expect(fileWrites()).toHaveLength(0)
  })

  it('does not let one unaddressable path become a verdict about the host', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    // A UNC destination has no settled mapping in sftp's drive-rooted namespace, so this write
    // falls back — but the host still serves sftp perfectly well for every other path.
    await uploadFileViaSystemSsh(
      target,
      join(localDir, 'relay.js'),
      '//fileserver/share/relay.js',
      { hostPlatform }
    )

    expect(fileWrites().length).toBeGreaterThan(0)
    expect(sftpBatches).toHaveLength(0)
    // The 30-minute capability cache is keyed by host; caching this would send every later write
    // to the same machine down the defective path on the strength of one odd destination.
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
    // `@($json | ConvertFrom-Json)` wraps the parsed array in another array, so the loop variable
    // binds to the whole thing and `[string]` of it is the paths joined by spaces — which
    // CreateDirectory rejects. It only ever worked for a single directory, where stringifying a
    // one-element array happens to yield the element, so no batch of one can catch this.
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

    // One refusal is enough; re-probing per file is a wasted round trip on every file.
    expect(sftpBatches).toHaveLength(1)
  })

  it('does not spend a sweep round trip when sftp declined before moving any bytes', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'x')

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    // A refused subsystem staged nothing, so there is nothing to delete — and on a host without
    // sftp that sweep would otherwise be paid on every single write.
    expect(commands.length).toBeGreaterThan(0)
    expect(commands.some((command) => command.script.includes('Delete($staging)'))).toBe(false)
  })

  it('prefers PowerShell 7, which reads a redirected stdin correctly', async () => {
    writeFileSync(join(localDir, 'relay.js'), Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3))

    await uploadFileViaSystemSsh(target, join(localDir, 'relay.js'), `${remoteRoot}/relay.js`, {
      hostPlatform
    })

    expect(fileWrites().map((write) => write.executable)).toEqual(['pwsh.exe'])
    // PowerShell 7 took 2MB through one exec when measured, so chunking it buys nothing.
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
    // A wedged PowerShell never closes on its own, so no wait on this path may be unbounded.
    // Count first: `every` is true of zero calls, so a wait that moved to a different helper would
    // pass this silently.
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
    // Spawn 0 is the pwsh write; fail it and every retry beneath it.
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
})

describe('last-resort Windows PowerShell failure reporting', () => {
  it('names the host limitation and its remedy, not just the timeout', () => {
    const timeout = new Error('write C:/x at offset 0 timed out after 60000ms with no response')

    const explained = explainWindowsPowerShellStdinFailure(timeout) as Error

    // "timed out" alone sends the user to retry a network they cannot fix; the fix is host-side.
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
      // POSIX `cat` drains its stdin; only the Windows writes need the bound.
      void waitForChannelClose(channel as never, 'posix write').then(settled, settled)

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
      expect(settled).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
