import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { spawnProcess } from '../../shared/child-process/run-process'
import type { SshConnection } from './ssh-connection'
import {
  EXEC_STDIN_WRITE_DONE,
  makeExecStdinWriteFileCommand,
  uploadDirectoryViaExecStdin,
  uploadFileViaExecStdin,
  writeStringViaExecStdin
} from './ssh-exec-stdin-file-transfer'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { makePosixWriteFileCommand } from './system-ssh-file-binary-transfer'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'exec-stdin-'))
  directories.push(dir)
  return dir
}

/** An ssh2-shaped exec channel over a local `/bin/sh -c`, so the real writer and shell run. */
function localShellConnection(rewrite: (command: string) => string = (c) => c): SshConnection {
  const conn = {
    exec: async (command: string) => {
      const child = spawnProcess({ program: '/bin/sh', args: ['-c', rewrite(command)] })
      const channel = new Duplex({
        autoDestroy: false,
        emitClose: false,
        read() {},
        // Why no error is forwarded: ssh2 silently drops writes once the remote side stops reading,
        // so EPIPE here would race the exit code and fail the upload for the wrong reason.
        write(chunk, encoding, callback) {
          if (child.stdin.destroyed) {
            callback()
            return
          }
          child.stdin.write(chunk, encoding, () => callback())
        },
        final(callback) {
          if (child.stdin.destroyed) {
            callback()
            return
          }
          child.stdin.end(() => callback())
        }
      })
      child.stdin.on('error', () => {})
      child.stdout.on('data', (data: Buffer) => channel.push(data))
      child.on('close', (code) => {
        channel.push(null)
        channel.emit('close', code)
      })
      return Object.assign(channel, {
        stdin: channel,
        stderr: child.stderr,
        close: () => child.kill('SIGKILL')
      })
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: execCommand only uses exec() and the channel surface built above.
  return conn as unknown as SshConnection
}

describe('exec-stdin write command construction', () => {
  it('keeps the system-SSH writer a plain cat redirection', () => {
    expect(makePosixWriteFileCommand('/h/a b')).toBe("cat > '/h/a b'")
    expect(makePosixWriteFileCommand('/h/x', { exclusive: true })).toBe("set -C; cat > '/h/x'")
  })

  it('wraps the same writer with a size check and an atomic rename for the ssh2 fallback', () => {
    const command = makeExecStdinWriteFileCommand("/h/o'dd/file", 42, { token: 'abc' })
    expect(command).toBe(
      [
        "{ mkdir -p '/h/o'\\''dd'",
        "cat > '/h/o'\\''dd/file.orca-part-abc'",
        `[ "$(wc -c < '/h/o'\\''dd/file.orca-part-abc' | tr -d ' ')" = 42 ]`,
        "mv -f '/h/o'\\''dd/file.orca-part-abc' '/h/o'\\''dd/file'",
        `echo ${EXEC_STDIN_WRITE_DONE}; } || { rm -f '/h/o'\\''dd/file.orca-part-abc'; exit 1; }`
      ].join(' && ')
    )
  })

  it('keeps the executable bit when asked and rejects an impossible size', () => {
    expect(makeExecStdinWriteFileCommand('/h/f', 1, { token: 't', executable: true })).toContain(
      "chmod 755 '/h/f.orca-part-t'"
    )
    expect(() => makeExecStdinWriteFileCommand('/h/f', -1, { token: 't' })).toThrow()
    expect(() => makeExecStdinWriteFileCommand('/h/f', 1.5, { token: 't' })).toThrow()
  })
})

describe.skipIf(process.platform === 'win32')('exec-stdin writer through a real shell', () => {
  it('streams a payload over 10 MB byte-for-byte', async () => {
    const dir = tempDir()
    const payload = randomBytes(12 * 1024 * 1024 + 7)
    const local = join(dir, 'runtime.tar.gz')
    writeFileSync(local, payload)
    const remote = join(dir, 'remote', 'nested', 'runtime.tar.gz')

    await uploadFileViaExecStdin(localShellConnection(), local, remote)

    const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    expect(sha(readFileSync(remote))).toBe(sha(payload))
    expect(readdirSync(join(dir, 'remote', 'nested'))).toEqual(['runtime.tar.gz'])
  }, 60_000)

  it('leaves no file behind when the host receives fewer bytes than were sent', async () => {
    const dir = tempDir()
    const local = join(dir, 'payload.bin')
    // Larger than any pipe buffer, so the shell always stops reading while bytes are still in flight.
    writeFileSync(local, randomBytes(1024 * 1024))
    const remote = join(dir, 'remote', 'payload.bin')
    // Models a stream cut short: the host keeps only the first 1000 bytes.
    const truncating = localShellConnection((command) =>
      command.replace(/cat > /, 'head -c 1000 > ')
    )

    await expect(uploadFileViaExecStdin(truncating, local, remote)).rejects.toThrow(/exit 1/)
    expect(existsSync(remote)).toBe(false)
    expect(readdirSync(join(dir, 'remote'))).toEqual([])
  })

  it('uploads a directory tree, including empty directories and executable modes', async () => {
    const dir = tempDir()
    const local = join(dir, 'local')
    mkdirSync(join(local, 'bin'), { recursive: true })
    mkdirSync(join(local, 'empty'))
    writeFileSync(join(local, 'relay.js'), 'console.log(1)\n')
    writeFileSync(join(local, 'bin', 'spawn-helper'), '#!/bin/sh\n')
    await chmod(join(local, 'bin', 'spawn-helper'), 0o755)
    const remote = join(dir, 'remote')

    await uploadDirectoryViaExecStdin(
      localShellConnection(),
      local,
      remote,
      getRemoteHostPlatform('linux-x64')
    )
    await writeStringViaExecStdin(localShellConnection(), join(remote, '.version'), '0.1.0+abc')

    expect(readFileSync(join(remote, 'relay.js'), 'utf8')).toBe('console.log(1)\n')
    expect(existsSync(join(remote, 'empty'))).toBe(true)
    expect(readFileSync(join(remote, '.version'), 'utf8')).toBe('0.1.0+abc')
    expect(statSync(join(remote, 'bin', 'spawn-helper')).mode & 0o111).not.toBe(0)
  })
})
