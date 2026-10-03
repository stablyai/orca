import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { existsSyncMock, spawnMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('fs', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  existsSync: existsSyncMock
}))

vi.mock('child_process', () => ({ spawn: spawnMock }))

import { uploadFileViaSystemSsh } from './ssh-system-fallback'
import { makeRemoveCreatedEntryCommand } from './system-ssh-remote-remove'
import { makePosixExclusiveCreateThenAppendCommand } from './system-ssh-file-binary-transfer'

const SYSTEM_SSH_PATH =
  process.platform === 'win32' ? 'C:\\Windows\\System32\\OpenSSH\\ssh.exe' : '/usr/bin/ssh'

function createChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    killed: false,
    exitCode: null,
    kill: vi.fn(() => true)
  })
  child.stdin.resume()
  return child
}

describe('system SSH exclusive upload', () => {
  let dir: string
  let source: string

  beforeEach(() => {
    existsSyncMock.mockReset().mockImplementation((path: string) => path === SYSTEM_SSH_PATH)
    spawnMock.mockReset()
    dir = mkdtempSync(join(tmpdir(), 'orca-system-ssh-upload-'))
    source = join(dir, 'payload.bin')
    writeFileSync(source, Buffer.from('payload'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function upload(remoteCreated: boolean): Promise<{ command: string; created: boolean }> {
    const child = createChild()
    spawnMock.mockReturnValue(child)
    let created = false
    const promise = uploadFileViaSystemSsh(
      { id: 't', label: 't', host: 'example.com', port: 22, username: 'deploy' },
      source,
      '/remote/payload.bin',
      {
        exclusive: true,
        onRemoteCreated: () => {
          created = true
        }
      }
    )
    if (remoteCreated) {
      child.stdout.write('ORCA_REMOTE_CREATED\n')
    }
    await new Promise<void>((resolve) => child.stdin.once('finish', resolve))
    child.emit('close', 0, null)
    await promise
    const args: string[] = spawnMock.mock.calls.at(-1)?.[1] ?? []
    return { command: args.at(-1) ?? '', created }
  }

  it('reports the create once the remote shell confirms it made the file', async () => {
    const { command, created } = await upload(true)
    // Why: noclobber fails the create before the marker when the file already exists.
    // (The wrapper encodes and chunks the command; the exact shape is pinned by the builder test.)
    expect(command).toContain('set -C;')
    // Why: noclobber still opens an existing FIFO/device/symlink; only a regular file may report.
    expect(command).toContain('ORCA_REMOTE_CREATED')
    // Why: writing through the fd opened by the create never reopens a swappable path.
    expect(command).toContain('exec cat >&3')
    expect(command).not.toContain('cat >>')
    expect(created).toBe(true)
  })

  it('never reports a create the remote shell did not confirm', async () => {
    expect((await upload(false)).created).toBe(false)
  })

  it('builds commands that never follow a swapped node or recurse', () => {
    // Why: noclobber still opens an existing FIFO/device/symlink; only a regular file may report.
    expect(makePosixExclusiveCreateThenAppendCommand('/r/a b')).toBe(
      "set -C; [ ! -e '/r/a b' ] && [ ! -L '/r/a b' ] && exec 3> '/r/a b' && [ -f '/r/a b' ] && [ ! -L '/r/a b' ] && printf '%s\\n' ORCA_REMOTE_CREATED && exec cat >&3"
    )
    expect(makeRemoveCreatedEntryCommand('/r/a b', 'file')).toBe(
      "[ -f '/r/a b' ] && [ ! -L '/r/a b' ] && rm -f -- '/r/a b'"
    )
    expect(makeRemoveCreatedEntryCommand('/r/a b', 'directory')).toBe("rmdir -- '/r/a b'")
  })
})
