/**
 * #16432: the Windows relay upload pushed the whole bundle into one PowerShell stdin, which
 * Windows PowerShell 5.1 cannot drain over a non-pty ssh exec — the remote blocks forever, and
 * `waitForChannelClose()` had no timeout, so the UI sat at "Connecting…" with no error. Covered
 * here: no write exceeds one stdin's worth on any Windows path (bundle upload *and* single-file
 * upload, which is the one that carries large files), a partial write never lands under the real
 * name, and a remote that never closes fails instead of hanging.
 */
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SystemSshOperationLifecycle from './system-ssh-operation-lifecycle'

const { spawnSystemSshCommandMock, waitForChannelCloseSpy } = vi.hoisted(() => ({
  spawnSystemSshCommandMock: vi.fn(),
  waitForChannelCloseSpy: vi.fn()
}))

vi.mock('./system-ssh-command', () => ({
  spawnSystemSshCommand: spawnSystemSshCommandMock
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
import type { SshTarget } from '../../shared/ssh-types'

type FakeChannel = EventEmitter & {
  stdin: Writable
  stderr: PassThrough
  close: () => void
  written: Buffer
}

const target = { id: 'win-1', host: 'win.example', username: 'dev' } as unknown as SshTarget
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

type RecordedCommand = { script: string; stdin: Buffer }

describe('Windows upload stdin framing', () => {
  let localDir: string
  const commands: RecordedCommand[] = []
  /** Index of the spawn that should report a non-zero exit, to model a chunk failing mid-file. */
  let failAtSpawn = -1

  const fileWrites = (): RecordedCommand[] =>
    commands.filter((command) => command.script.includes('FileMode]::'))
  const writtenPath = (command: RecordedCommand): string =>
    /\$path = '((?:[^']|'')*)'/.exec(command.script)?.[1].replace(/''/g, "'") ?? ''
  const fileMode = (command: RecordedCommand): string | undefined =>
    /FileMode\]::(\w+)/.exec(command.script)?.[1]

  beforeEach(() => {
    commands.length = 0
    failAtSpawn = -1
    waitForChannelCloseSpy.mockClear()
    localDir = mkdtempSync(join(tmpdir(), 'orca-win-upload-'))
    spawnSystemSshCommandMock.mockReset()
    spawnSystemSshCommandMock.mockImplementation((_target: SshTarget, command: string) => {
      const spawnIndex = spawnSystemSshCommandMock.mock.calls.length - 1
      return createFakeChannel((channel) => {
        commands.push({ script: decodePowerShellCommand(command), stdin: channel.written })
        setImmediate(() =>
          spawnIndex === failAtSpawn
            ? channel.emit('close', 1, null)
            : channel.emit('close', 0, null)
        )
      })
    })
  })

  afterEach(async () => {
    await rm(localDir, { recursive: true, force: true })
  })

  it('never pushes a whole artifact bundle into one PowerShell stdin', async () => {
    mkdirSync(join(localDir, 'node'), { recursive: true })
    // Comfortably past the ~50KB point at which the reporter measured PowerShell 5.1 wedging.
    writeFileSync(join(localDir, 'node', 'relay.js'), Buffer.alloc(600 * 1024, 0x61))
    writeFileSync(join(localDir, 'index.js'), Buffer.alloc(300 * 1024, 0x62))

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    const largest = Math.max(...commands.map((command) => command.stdin.length))
    expect(largest).toBeLessThanOrEqual(WINDOWS_STDIN_WRITE_CHUNK_BYTES)
    // The base64 + JSON envelope is gone entirely: nothing reads the bundle as one string.
    expect(commands.some((command) => command.script.includes('FromBase64String'))).toBe(false)
    // `[Console]::In` wedged at 50KB where the stream reader did not, so the mkdir batch — the one
    // payload still read as a string — must use the reader the reporter measured surviving.
    expect(commands.some((command) => command.script.includes('[Console]::In.ReadToEnd()'))).toBe(
      false
    )
    expect(
      commands.filter((command) => command.script.includes('StreamReader([Console]::'))
    ).toHaveLength(1)
  })

  it('bounds the single-file upload too, which is the path large files take', async () => {
    const contents = Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3 + 11, 0x64)
    const localPath = join(localDir, 'big.node')
    writeFileSync(localPath, contents)

    await uploadFileViaSystemSsh(target, localPath, `${remoteRoot}/big.node`, { hostPlatform })

    const writes = fileWrites()
    expect(writes).toHaveLength(4)
    expect(Math.max(...writes.map((write) => write.stdin.length))).toBe(
      WINDOWS_STDIN_WRITE_CHUNK_BYTES
    )
    expect(Buffer.concat(writes.map((write) => write.stdin)).equals(contents)).toBe(true)
    // A wedged PowerShell never closes on its own, so no wait on this path may be unbounded.
    expect(
      waitForChannelCloseSpy.mock.calls.every((call) => call[2] === WINDOWS_STDIN_WRITE_TIMEOUT_MS)
    ).toBe(true)
  })

  it('writes every byte of every artifact across the chunked writes', async () => {
    const contents = Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 2 + 17, 0x63)
    writeFileSync(join(localDir, 'relay.js'), contents)

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    const writes = fileWrites()
    expect(writes).toHaveLength(3)
    expect(Buffer.concat(writes.map((write) => write.stdin)).equals(contents)).toBe(true)
    // Only the first write creates the staging file; the rest must extend it or it is truncated.
    expect(writes.map(fileMode)).toEqual(['Create', 'Append', 'Append'])
  })

  it('still creates an empty artifact on the host', async () => {
    writeFileSync(join(localDir, 'empty.txt'), '')

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    expect(fileWrites().map(writtenPath)).toEqual([`${remoteRoot}/empty.txt`])
    expect(fileWrites()[0].stdin).toHaveLength(0)
    expect(fileMode(fileWrites()[0])).toBe('Create')
  })

  it('lands a multi-chunk write on a staging path and publishes it by rename', async () => {
    const remotePath = `${remoteRoot}/relay.js`
    writeFileSync(join(localDir, 'relay.js'), Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES + 1))

    await uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })

    // Nothing touches the real name until every byte is on the host.
    expect(fileWrites().map(writtenPath)).toEqual([
      `${remotePath}${WINDOWS_STAGED_WRITE_SUFFIX}`,
      `${remotePath}${WINDOWS_STAGED_WRITE_SUFFIX}`
    ])
    const publish = commands.at(-1)!
    expect(publish.script).toContain('[System.IO.File]::Move($staging, $path)')
    expect(publish.script).toContain('[System.IO.File]::Delete($path)')
  })

  it('leaves no truncated file under the real name when a chunk fails mid-file', async () => {
    writeFileSync(join(localDir, 'relay.js'), Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES * 3))
    // Spawns: 0 = mkdir batch, 1..3 = chunk writes. Fail the second chunk.
    failAtSpawn = 2

    await expect(
      uploadDirectoryViaSystemSsh(target, localDir, remoteRoot, { hostPlatform })
    ).rejects.toThrow()

    expect(fileWrites().map(writtenPath)).not.toContain(`${remoteRoot}/relay.js`)
    expect(commands.some((command) => command.script.includes('::Move('))).toBe(false)
  })

  it('enforces exclusive once at the rename, so a retry is not blocked by its own leftovers', async () => {
    const localPath = join(localDir, 'import.bin')
    writeFileSync(localPath, Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES + 1))

    await uploadFileViaSystemSsh(target, localPath, `${remoteRoot}/import.bin`, {
      hostPlatform,
      exclusive: true
    })

    // CreateNew on chunk one would fail against a leftover staging file from a failed attempt;
    // `File::Move` raising on an existing destination is what carries the exclusive contract.
    expect(fileWrites().map(fileMode)).toEqual(['Create', 'Append'])
    const publish = commands.at(-1)!
    expect(publish.script).toContain('[System.IO.File]::Move($staging, $path)')
    expect(publish.script).not.toContain('[System.IO.File]::Delete($path)')
  })

  it('keeps a single-chunk write on the destination, with the caller mode intact', async () => {
    await writeBufferViaSystemSsh(target, `${remoteRoot}/version`, Buffer.from('1.2.3'), {
      hostPlatform,
      exclusive: true
    })

    expect(fileWrites()).toHaveLength(1)
    expect(writtenPath(fileWrites()[0])).toBe(`${remoteRoot}/version`)
    expect(fileMode(fileWrites()[0])).toBe('CreateNew')
    expect(commands.some((command) => command.script.includes('::Move('))).toBe(false)
  })

  it('appends onto the destination rather than staging, since append cannot be staged', async () => {
    const remotePath = `${remoteRoot}/log.bin`
    await writeBufferViaSystemSsh(
      target,
      remotePath,
      Buffer.alloc(WINDOWS_STDIN_WRITE_CHUNK_BYTES + 1),
      { hostPlatform, append: true }
    )

    expect(fileWrites().map(writtenPath)).toEqual([remotePath, remotePath])
    expect(fileWrites().map(fileMode)).toEqual(['Append', 'Append'])
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
