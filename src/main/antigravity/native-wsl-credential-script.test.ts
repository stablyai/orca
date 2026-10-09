import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  chmod,
  rm,
  writeFile,
  readFile,
  readdir,
  stat,
  symlink
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  buildAntigravityWslCredentialCommand,
  decodeAntigravityWslReply
} from './native-wsl-credential-script'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { credential } from './native-account-test-fixtures'

async function wslScriptFixture() {
  const home = await mkdtemp(join(homedir(), '.orca-agy-guest-test-'))
  const directory = join(home, '.gemini', 'antigravity-cli')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(home, 0o700)
  const path = join(directory, 'antigravity-oauth-token')
  const authority = {
    distro: 'Ubuntu',
    uid: process.getuid?.() ?? 0,
    home,
    canonicalHome: home,
    authorityId: 'a'.repeat(64),
    credentialPath: path
  }
  return {
    home,
    path,
    directory,
    authority,
    put: (contents: string, mode = 0o600) => writeFile(path, contents, { mode }),
    clean: () => rm(home, { recursive: true, force: true }),
    async run(action: 'read' | 'write', prefix = '', deadline = Date.now() + 5000, input?: string) {
      const command = buildAntigravityWslCredentialCommand('read', authority, 'abc123', deadline)
      if (command.script === undefined) {
        throw new Error('Expected guest script')
      }
      return runProcess({
        program: '/bin/sh',
        args: ['-c', prefix + command.script, '--', action, ...(command.args ?? []).slice(1)],
        env: { ...process.env, HOME: home, WSL_DISTRO_NAME: 'Ubuntu' },
        input,
        timeoutMs: 5000,
        maxOutputBytes: 192 * 1024,
        killOnOutputLimit: true
      })
    }
  }
}

let guest: Awaited<ReturnType<typeof wslScriptFixture>>
describe.runIf(process.platform === 'linux')('isolated POSIX guest script evidence', () => {
  beforeEach(async () => {
    guest = await wslScriptFixture()
  })
  afterEach(async () => {
    await guest.clean()
  })
  it('reads exact private bytes without modifying the native file or its directory', async () => {
    await guest.put(credential('a'))
    const before = await stat(guest.path)
    const files = await readdir(guest.directory)
    const read = await guest.run('read')
    expect(read.code).toBe(0)
    expect(decodeAntigravityWslReply(read.stdout, 'abc123')).toEqual({
      status: 'present',
      contents: credential('a')
    })
    expect(await readFile(guest.path, 'utf8')).toBe(credential('a'))
    const after = await stat(guest.path)
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
    expect(await readdir(guest.directory)).toEqual(files)
    expect((await stat(guest.path)).mode & 0o777).toBe(0o600)
  })
  it.each([
    'id() { printf %s 4294967295; }\n',
    'WSL_DISTRO_NAME=Other\n',
    'readlink() { printf %s /other; }\n'
  ])('refuses reads when guest identity changes (%s)', async (prefix) => {
    await guest.put(credential('a'))
    const result = await guest.run('read', prefix)
    expect(result.code).toBe(74)
    expect(result.stdout).toBe('')
    expect(await readFile(guest.path, 'utf8')).toBe(credential('a'))
  })
  it.each([-300, 300])(
    'reads credentials with a guest clock offset of %i seconds',
    async (offset) => {
      await guest.put(credential('a'))
      const prefix = `date() { printf '%s\\n' "$(( $(command date +%s) + ${offset} ))"; }\n`
      const result = await guest.run('read', prefix)
      expect(result.code).toBe(0)
      expect(decodeAntigravityWslReply(result.stdout, 'abc123')).toEqual({
        status: 'present',
        contents: credential('a')
      })
    }
  )
  it.each([
    { state: 'missing', initial: null },
    { state: 'signed in', initial: credential('a') },
    { state: 'refreshed', initial: credential('a', 2) }
  ])(
    'refuses a forged write action without creating, replacing or deleting native files ($state)',
    async ({ initial }) => {
      if (initial !== null) {
        await guest.put(initial)
      }
      const files = await readdir(guest.directory)
      const expected = initial === null ? 'missing' : Buffer.from(initial).toString('base64')
      const input = `ORCA_AGY_WSL_INPUT_V1\n${expected}\n${Buffer.from(credential('b')).toString('base64')}\n`
      const result = await guest.run('write', '', undefined, input)
      expect(result.code).toBe(65)
      expect(result.stdout).toBe('')
      expect(await readdir(guest.directory)).toEqual(files)
      if (initial === null) {
        await expect(readFile(guest.path)).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(await readFile(guest.path, 'utf8')).toBe(initial)
      }
    }
  )
  it('rejects a forged write before creating missing native directories', async () => {
    await rm(join(guest.home, '.gemini'), { recursive: true })
    const result = await guest.run('write')
    expect(result.code).toBe(65)
    expect(await readdir(guest.home)).toEqual([])
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
  it('rejects overlarge tokens before exposing them', async () => {
    await guest.put('x'.repeat(65537))
    expect((await guest.run('read')).code).not.toBe(0)
  })
  it('returns an explicit missing frame', async () => {
    const result = await guest.run('read')
    expect(result.code).toBe(0)
    expect(decodeAntigravityWslReply(result.stdout, 'abc123')).toEqual({ status: 'missing' })
  })
  it('reads missing native directories without creating them', async () => {
    await rm(join(guest.home, '.gemini'), { recursive: true })
    const result = await guest.run('read')
    expect(result.code).toBe(0)
    expect(decodeAntigravityWslReply(result.stdout, 'abc123')).toEqual({ status: 'missing' })
    expect(await readdir(guest.home)).toEqual([])
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
  it('does not remove old Orca staging files while reading native credentials', async () => {
    await guest.put(credential('a'))
    const staging = join(guest.directory, '.orca-agy-stage.ABCDEFGHIJKL')
    await mkdir(staging, { mode: 0o700 })
    const staged = join(staging, 'token')
    await writeFile(staged, credential('b'), { mode: 0o600 })
    expect((await guest.run('read')).code).toBe(0)
    expect(await readFile(staged, 'utf8')).toBe(credential('b'))
  })
  it('detects an independent in-place refresh while reading without rolling it back', async () => {
    await guest.put(credential('a'))
    const prefix = `stat() { command stat "$@"; if [ "$1" = -c ] && [ "$2" = '%d:%i:%u:%a:%h:%s:%y:%z' ] && [ "$4" = ${quotePosixShell(guest.path)} ]; then printf %s ${quotePosixShell(credential('a', 2))} > "$4"; fi; }\n`
    const result = await guest.run('read', prefix)
    expect(result.code).toBe(73)
    expect(await readFile(guest.path, 'utf8')).toBe(credential('a', 2))
  })
  it('reads without relying on a lock that the native CLI does not share', async () => {
    await guest.put(credential('a'))
    const lock = join(guest.directory, '.orca-antigravity-account.lock')
    await writeFile(lock, '', { mode: 0o600 })
    const marker = join(guest.directory, 'locked')
    const holder = runProcess({
      program: '/usr/bin/flock',
      args: [lock, '/bin/sh', '-c', `touch ${quotePosixShell(marker)}; sleep 3`],
      timeoutMs: 5000
    })
    await vi.waitFor(async () => expect((await stat(marker)).isFile()).toBe(true))
    try {
      const result = await guest.run('read')
      expect(result.code).toBe(0)
      expect(decodeAntigravityWslReply(result.stdout, 'abc123')).toEqual({
        status: 'present',
        contents: credential('a')
      })
    } finally {
      await holder
    }
  })
})

it.runIf(process.platform === 'linux')(
  'does not recreate a credential deleted between stat and read',
  async () => {
    const fixture = await wslScriptFixture()
    try {
      await fixture.put(credential('a'))
      const prefix = `stat() { command stat "$@"; if [ "$1" = -c ] && [ "$2" = '%d:%i:%u:%a:%h:%s:%y:%z' ] && [ "$4" = ${quotePosixShell(fixture.path)} ]; then rm -f -- "$4"; fi; }\n`
      expect((await fixture.run('read', prefix)).code).not.toBe(0)
      await expect(readFile(fixture.path)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await fixture.clean()
    }
  }
)

it.runIf(process.platform === 'linux')(
  'bounds a FIFO replacement racing the read-only open',
  async () => {
    const fixture = await wslScriptFixture()
    try {
      await fixture.put(credential('a'))
      const prefix = `date() { printf '%s\\n' "$(( $(command date +%s) - 300 ))"; }\nstat() { command stat "$@"; if [ "$1" = -c ] && [ "$2" = '%d:%i:%u:%a:%h:%s:%y:%z' ] && [ "$4" = ${quotePosixShell(fixture.path)} ]; then rm -f -- "$4"; mkfifo -m 600 -- "$4"; fi; }\n`
      const started = performance.now()
      const result = await fixture.run('read', prefix, Date.now() + 2000)
      expect(result.code).not.toBe(0)
      expect(result.timedOut).toBe(false)
      expect(result.stdout).toBe('')
      expect(performance.now() - started).toBeLessThan(3500)
    } finally {
      await fixture.clean()
    }
  }
)

const digest = (value: Buffer) => createHash('sha256').update(value).digest('hex')
describe.runIf(process.platform === 'linux')('private guest HOME isolation', () => {
  let first: Awaited<ReturnType<typeof wslScriptFixture>>
  let second: Awaited<ReturnType<typeof wslScriptFixture>>
  beforeEach(async () => {
    first = await wslScriptFixture()
    second = await wslScriptFixture()
  })
  afterEach(async () => {
    await first.clean()
    await second.clean()
  })
  it('keeps independent credential authorities unchanged on refused writes and cleanup', async () => {
    await first.put(credential('first'))
    await second.put(credential('second'))
    const before = digest(await readFile(second.path))
    const input = `ORCA_AGY_WSL_INPUT_V1\n${Buffer.from(credential('first')).toString('base64')}\n${Buffer.from(credential('replacement')).toString('base64')}\n`
    expect((await first.run('write', '', undefined, input)).code).toBe(65)
    expect(await readFile(first.path, 'utf8')).toBe(credential('first'))
    expect(digest(await readFile(second.path))).toBe(before)
    await first.clean()
    expect(digest(await readFile(second.path))).toBe(before)
    const read = await second.run('read')
    expect(decodeAntigravityWslReply(read.stdout, 'abc123')).toEqual({
      status: 'present',
      contents: credential('second')
    })
  })
})
