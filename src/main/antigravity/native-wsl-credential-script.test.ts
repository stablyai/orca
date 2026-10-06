import { runProcess } from '../../shared/child-process/run-process'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { chmod, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { wslScriptFixture } from './native-wsl-credential-script-fixtures'
import { decodeAntigravityWslReply } from './native-wsl-credential-protocol'
import { credential } from './native-account-test-fixtures'
let guest: Awaited<ReturnType<typeof wslScriptFixture>>
describe.skipIf(process.platform === 'win32')('isolated POSIX guest script evidence', () => {
  beforeEach(async () => {
    guest = await wslScriptFixture()
  })
  afterEach(async () => {
    await guest.clean()
  })
  it('reads exact private bytes and atomically switches with readback', async () => {
    await guest.put(credential('a'))
    const read = await guest.run('read')
    expect(read.code).toBe(0)
    expect(decodeAntigravityWslReply(read.stdout, 'abc123')).toEqual({
      status: 'present',
      contents: credential('a')
    })
    const written = await guest.run('write', credential('b'), credential('a'))
    expect(written.code).toBe(0)
    expect(await readFile(guest.path, 'utf8')).toBe(credential('b'))
    expect((await stat(guest.path)).mode & 0o777).toBe(0o600)
  })
  it.each([0o644, 0o400, 0o700])(
    'refuses unsafe mode %o without credential output',
    async (mode) => {
      await guest.put(credential('a'))
      await chmod(guest.path, mode)
      const result = await guest.run('read')
      expect(result.code).not.toBe(0)
      expect(result.stdout).not.toContain('synthetic')
    }
  )
  it('refuses symlinks and writable parents', async () => {
    const other = `${guest.path}.other`
    await writeFile(other, credential('a'), { mode: 0o600 })
    await symlink(other, guest.path)
    expect((await guest.run('read')).code).not.toBe(0)
  })
  it('preserves the current bytes on an expected-value conflict', async () => {
    await guest.put(credential('a'))
    expect((await guest.run('write', credential('b'), credential('stale'))).code).toBe(73)
    expect(await readFile(guest.path, 'utf8')).toBe(credential('a'))
  })
  it('rejects overlarge tokens before exposing them', async () => {
    await guest.put('x'.repeat(65537))
    expect((await guest.run('read')).code).not.toBe(0)
  })
  it('returns an explicit missing frame', async () => {
    const result = await guest.run('read')
    expect(result.code).toBe(0)
    expect(decodeAntigravityWslReply(result.stdout, 'abc123')).toEqual({ status: 'missing' })
  })
  it('refuses a writable credential directory', async () => {
    await guest.put(credential('a'))
    await chmod(guest.directory, 0o777)
    expect((await guest.run('read')).code).toBe(77)
  })
  it('rejects a FIFO before opening it', async () => {
    await runProcess({
      program: '/usr/bin/mkfifo',
      args: ['-m', '600', guest.path],
      timeoutMs: 1000
    })
    const result = await guest.run('read')
    expect(result.code).toBe(77)
    expect(result.timedOut).toBe(false)
  })
  it('preserves credentials when the staging sync fails', async () => {
    await guest.put(credential('a'))
    const result = await guest.run(
      'write',
      credential('b'),
      credential('a'),
      'sync() { return 1; }\n'
    )
    expect(result.code).toBe(74)
    expect(await readFile(guest.path, 'utf8')).toBe(credential('a'))
  })
  it('detects an independent in-place refresh before rename without rolling it back', async () => {
    await guest.put(credential('a'))
    const prefix = `sync() { printf %s ${quotePosixShell(credential('a', 2))} > ${quotePosixShell(guest.path)}; command sync "$@"; }\n`
    const result = await guest.run('write', credential('b'), credential('a'), prefix)
    expect(result.code).toBe(73)
    expect(await readFile(guest.path, 'utf8')).toBe(credential('a', 2))
  })
  it('limits lock contention to two seconds', async () => {
    await guest.put(credential('a'))
    const lock = `${guest.directory}/.orca-antigravity-account.lock`
    await writeFile(lock, '', { mode: 0o600 })
    const marker = `${guest.directory}/locked`
    const holder = runProcess({
      program: '/usr/bin/flock',
      args: [lock, '/bin/sh', '-c', `touch ${quotePosixShell(marker)}; sleep 3`],
      timeoutMs: 5000
    })
    await vi.waitFor(async () => expect((await stat(marker)).isFile()).toBe(true))
    try {
      expect((await guest.run('read')).code).toBe(76)
    } finally {
      await holder
    }
  })
})
