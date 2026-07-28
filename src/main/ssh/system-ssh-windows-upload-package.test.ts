import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const { existsSyncMock, spawnMock, stringifyMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn(),
  stringifyMock: vi.fn()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, existsSync: existsSyncMock }
})

vi.mock('child_process', () => ({ spawn: spawnMock }))

// Spies the bounded serializer while delegating to its real implementation, so the upload
// path can be asserted to route through it — a plain JSON.stringify leaves the spy uncalled.
vi.mock('../../shared/memory-safety/node-bounded-json-stringify', async (importOriginal) => {
  const actual = (await importOriginal()) as {
    stringifyJsonWithinByteLimit: (...args: unknown[]) => unknown
  }
  stringifyMock.mockImplementation((...args: unknown[]) =>
    actual.stringifyJsonWithinByteLimit(...args)
  )
  return { ...actual, stringifyJsonWithinByteLimit: stringifyMock }
})

import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../shared/memory-safety/node-bounded-json-stringify'
import {
  SSH_DIRECTORY_TRANSFER_LIMITS,
  SshDirectoryTransferCapacityError,
  WINDOWS_SSH_UPLOAD_PACKAGE_MAX_BYTES
} from './ssh-directory-transfer-budget'
import { uploadDirectoryViaSystemSsh } from './system-ssh-file-transfer'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import type { SshTarget } from '../../shared/ssh-types'

type WindowsUploadEntry =
  | { kind: 'directory'; path: string }
  | { kind: 'file'; path: string; contentsBase64: string }

/** Builds a package whose serialized size straddles the ceiling without allocating far past it. */
function packageOfSerializedSize(targetBytes: number): WindowsUploadEntry[] {
  const entries: WindowsUploadEntry[] = [{ kind: 'directory', path: 'C:\\dst' }]
  const overhead = JSON.stringify([
    ...entries,
    { kind: 'file', path: 'C:\\dst\\f', contentsBase64: '' }
  ]).length
  entries.push({
    kind: 'file',
    path: 'C:\\dst\\f',
    contentsBase64: 'a'.repeat(Math.max(0, targetBytes - overhead))
  })
  return entries
}

describe('windows SSH upload package ceiling', () => {
  it('serializes a package at the exact 48 MiB ceiling', () => {
    // Literal ceiling: sizing the fixture from the constant would pass at any value.
    expect(WINDOWS_SSH_UPLOAD_PACKAGE_MAX_BYTES).toBe(48 * 1024 * 1024)

    const entries = packageOfSerializedSize(48 * 1024 * 1024)
    const result = stringifyJsonWithinByteLimit(entries, WINDOWS_SSH_UPLOAD_PACKAGE_MAX_BYTES)

    expect(result.byteLength).toBe(48 * 1024 * 1024)
  })

  it('rejects a package one byte past the ceiling instead of buffering it', () => {
    const entries = packageOfSerializedSize(48 * 1024 * 1024 + 1)

    expect(() =>
      stringifyJsonWithinByteLimit(entries, WINDOWS_SSH_UPLOAD_PACKAGE_MAX_BYTES)
    ).toThrow(JsonStringifyByteLimitError)
  })
})

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'

type EventedProcess = EventEmitter & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> }
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

function createTarget(): SshTarget {
  return { id: 'target-1', label: 'Test Server', host: 'example.com', port: 22, username: 'deploy' }
}

/**
 * Exercises the real upload entry point rather than the budget class, so deleting the
 * wiring — the budget construction, the per-entry charges, or the bounded serialization —
 * fails here instead of leaving a green suite around an unapplied ceiling.
 */
describe('windows SSH folder upload applies the transfer budget', () => {
  let localDir: string
  let spawned: EventedProcess[]

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), 'orca-upload-budget-'))
    spawned = []
    existsSyncMock.mockImplementation((p: string) => p === SYSTEM_SSH_PATH)
    // Why: the ceiling tests above call the serializer directly, so without a clear the
    // call-site assertions below would be satisfied by those calls rather than the upload.
    stringifyMock.mockClear()
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
      const proc = createEventedProcess()
      spawned.push(proc)
      queueMicrotask(() => proc.emit('close', 0, null))
      return proc
    })
  })

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true })
  })

  function upload(): Promise<void> {
    return uploadDirectoryViaSystemSsh(createTarget(), localDir, 'C:/dst', {
      hostPlatform: getRemoteHostPlatform('win32-x64')
    })
  }

  it('rejects a tree past the entry ceiling before spawning ssh', async () => {
    expect(SSH_DIRECTORY_TRANSFER_LIMITS.maximumEntries).toBe(4_096)
    for (let index = 0; index <= 4_096; index += 1) {
      writeFileSync(join(localDir, `f${index}`), '')
    }

    await expect(upload()).rejects.toThrow(SshDirectoryTransferCapacityError)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a tree past the depth ceiling before spawning ssh', async () => {
    expect(SSH_DIRECTORY_TRANSFER_LIMITS.maximumDepth).toBe(64)
    let nested = localDir
    for (let depth = 0; depth <= 64; depth += 1) {
      nested = join(nested, 'd')
      mkdirSync(nested)
    }

    await expect(upload()).rejects.toThrow(SshDirectoryTransferCapacityError)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a single file past the per-file ceiling before spawning ssh', async () => {
    expect(SSH_DIRECTORY_TRANSFER_LIMITS.maximumFileBytes).toBe(16 * 1024 * 1024)
    writeFileSync(join(localDir, 'big'), Buffer.alloc(16 * 1024 * 1024 + 1))

    await expect(upload()).rejects.toThrow(SshDirectoryTransferCapacityError)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('rejects a tree past the total-bytes ceiling before spawning ssh', async () => {
    expect(SSH_DIRECTORY_TRANSFER_LIMITS.maximumTotalFileBytes).toBe(32 * 1024 * 1024)
    const chunk = Buffer.alloc(8 * 1024 * 1024)
    for (let index = 0; index < 5; index += 1) {
      writeFileSync(join(localDir, `chunk${index}`), chunk)
    }

    await expect(upload()).rejects.toThrow(SshDirectoryTransferCapacityError)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('reports an oversized package as a typed capacity failure, not a raw JSON error', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'console.log("relay")')
    stringifyMock.mockImplementationOnce((_value: unknown, maxBytes: number) => {
      throw new JsonStringifyByteLimitError(maxBytes + 1, maxBytes)
    })

    await expect(upload()).rejects.toMatchObject({
      name: 'SshDirectoryTransferCapacityError',
      reason: 'package'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('uploads an ordinary tree and streams the bounded package to ssh', async () => {
    writeFileSync(join(localDir, 'relay.js'), 'console.log("relay")')
    mkdirSync(join(localDir, 'lib'))
    writeFileSync(join(localDir, 'lib', 'inner.js'), 'inner')

    await expect(upload()).resolves.toBeUndefined()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    // The package must be serialized through the byte-bounded path, at the advertised ceiling.
    expect(stringifyMock).toHaveBeenCalledWith(expect.anything(), 48 * 1024 * 1024)
    const payload = JSON.parse(
      spawned[0].stdin.end.mock.calls[0]?.[0] as string
    ) as WindowsUploadEntry[]
    expect(payload).toEqual(
      expect.arrayContaining([
        { kind: 'directory', path: 'C:/dst' },
        { kind: 'directory', path: 'C:/dst/lib' },
        {
          kind: 'file',
          path: 'C:/dst/relay.js',
          contentsBase64: Buffer.from('console.log("relay")').toString('base64')
        },
        {
          kind: 'file',
          path: 'C:/dst/lib/inner.js',
          contentsBase64: Buffer.from('inner').toString('base64')
        }
      ])
    )
  })
})
