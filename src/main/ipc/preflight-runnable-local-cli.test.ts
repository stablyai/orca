import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import {
  execLocalPreflightCommandOrThrow,
  findRunnableLocalCommand,
  isCommandAvailable,
  isCommandOnPath
} from './preflight-command-exec'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'

const COMMAND = 'orca-22975-gh'
const BROKEN_SHIM = 'echo broken-shim >&2\nexit 126\n'
let root = ''

async function cliInDirectory(label: string, body = 'echo gh-version-fixture\n'): Promise<string> {
  const dir = path.join(root, label)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, COMMAND),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${quotePosixShell(path.join(dir, 'argv.txt'))}\n${body}`,
    { mode: 0o755 }
  )
  return dir
}

async function probedArgs(dir: string): Promise<string[]> {
  try {
    return (await readFile(path.join(dir, 'argv.txt'), 'utf8')).split('\n').filter(Boolean)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

describe.skipIf(process.platform === 'win32')(
  'local CLI version probes with real processes',
  () => {
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'orca-22975-case-'))
      vi.stubEnv('HOME', root)
    })

    afterEach(async () => {
      vi.unstubAllEnvs()
      await removeTree(root)
    })

    it('detects a runnable copy behind an executable shim that exits 126', async () => {
      const shim = await cliInDirectory('shim', BROKEN_SHIM)
      const good = await cliInDirectory('good')
      vi.stubEnv('PATH', [shim, good].join(path.delimiter))

      await expect(isCommandOnPath(COMMAND)).resolves.toBe(true)
      await expect(
        execLocalPreflightCommandOrThrow(path.join(shim, COMMAND), ['--version'])
      ).rejects.toMatchObject({ code: 126, stderr: 'broken-shim\n' })
      await expect(
        execLocalPreflightCommandOrThrow(path.join(good, COMMAND), ['--version'])
      ).resolves.toMatchObject({ stdout: 'gh-version-fixture\n' })
      await expect(isCommandAvailable(COMMAND)).resolves.toBe(true)
      await expect(findRunnableLocalCommand(COMMAND)).resolves.toEqual({
        status: 'available',
        binary: path.join(good, COMMAND)
      })
    })

    it('distinguishes exhausted failing copies from an absent command', async () => {
      const first = await cliInDirectory('first', BROKEN_SHIM)
      const second = await cliInDirectory('second', BROKEN_SHIM)
      vi.stubEnv('PATH', [first, second].join(path.delimiter))

      await expect(findRunnableLocalCommand(COMMAND)).resolves.toEqual({
        status: 'exec_failed',
        binary: path.join(second, COMMAND)
      })
      await expect(findRunnableLocalCommand('orca-22975-absent-cli')).resolves.toEqual({
        status: 'absent'
      })
      expect(await probedArgs(first)).toEqual(['--version'])
      expect(await probedArgs(second)).toEqual(['--version'])
    })

    it('never substitutes another binary for an explicit failing path', async () => {
      const shim = await cliInDirectory('shim', BROKEN_SHIM)
      const good = await cliInDirectory('good')
      vi.stubEnv('PATH', good)
      const selected = path.join(shim, COMMAND)

      await expect(findRunnableLocalCommand(selected)).resolves.toEqual({
        status: 'exec_failed',
        binary: selected
      })
      expect(await probedArgs(good)).toEqual([])
    })

    it('recovers a working copy after a real launcher timeout', async () => {
      const marker = path.join(root, 'descendant-terminated')
      const childScript = `trap ${quotePosixShell(`printf terminated > ${quotePosixShell(marker)}; exit 0`)} TERM\n/bin/sleep 30 &\nwait\n`
      const hung = await cliInDirectory(
        'hung',
        `/bin/sh -c ${quotePosixShell(childScript)} &\nwait\n`
      )
      const good = await cliInDirectory('good')
      vi.stubEnv('PATH', [hung, good].join(path.delimiter))

      await expect(findRunnableLocalCommand(COMMAND)).resolves.toEqual({
        status: 'available',
        binary: path.join(good, COMMAND)
      })
      expect(await probedArgs(hung)).toEqual(['--version'])
      expect(await probedArgs(good)).toEqual(['--version'])
      expect(await readFile(marker, 'utf8')).toBe('terminated')
    }, 15_000)

    it('uses the known Nix install directory after PATH copies fail', async () => {
      const shim = await cliInDirectory('shim', BROKEN_SHIM)
      const profile = await cliInDirectory(path.join('.nix-profile', 'bin'))
      vi.stubEnv('PATH', shim)

      await expect(findRunnableLocalCommand(COMMAND)).resolves.toEqual({
        status: 'available',
        binary: path.join(profile, COMMAND)
      })
    })
  }
)

describe.runIf(process.platform === 'win32')('Windows preflight batch shims', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orca-22975-cmd-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await removeTree(root)
  })

  it('runs the next cmd shim after an earlier copy exits 126', async () => {
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    for (const dir of [first, second]) {
      await mkdir(dir)
    }
    const name = `${COMMAND}.CMD`
    await writeFile(path.join(first, name), '@echo off\r\nexit /b 126\r\n')
    await writeFile(
      path.join(second, name),
      '@echo off\r\necho gh-version-fixture\r\nexit /b 0\r\n'
    )
    vi.stubEnv('PATH', [first, second].join(path.delimiter))
    vi.stubEnv('Path', [first, second].join(path.delimiter))

    const result = await findRunnableLocalCommand(COMMAND)

    expect(result).toEqual({ status: 'available', binary: path.posix.join(second, name) })
    if (result.status === 'available') {
      await expect(
        execLocalPreflightCommandOrThrow(result.binary, ['auth', 'status'])
      ).resolves.toMatchObject({ stdout: expect.stringContaining('gh-version-fixture') })
    }
  })

  // Include the probe, tree-cleanup deadline, and recovery probe on a busy Windows runner.
  it('recovers after a hung batch launcher and terminates its Node child', async () => {
    const first = path.join(root, 'hung')
    const second = path.join(root, 'working')
    await mkdir(first)
    await mkdir(second)
    const name = `${COMMAND}.CMD`
    await writeFile(
      path.join(first, 'hang.js'),
      `require('node:fs').writeFileSync(require('node:path').join(__dirname, 'child.pid'), String(process.pid)); setTimeout(function () {}, 60000);`
    )
    await writeFile(path.join(first, name), `@echo off\r\n"${process.execPath}" "%~dp0hang.js"\r\n`)
    await writeFile(
      path.join(second, name),
      '@echo off\r\necho gh-version-fixture\r\nexit /b 0\r\n'
    )
    vi.stubEnv('PATH', [first, second].join(path.delimiter))
    vi.stubEnv('Path', [first, second].join(path.delimiter))

    await expect(findRunnableLocalCommand(COMMAND)).resolves.toEqual({
      status: 'available',
      binary: path.posix.join(second, name)
    })
    const childPid = Number(await readFile(path.join(first, 'child.pid'), 'utf8'))
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true)
    expect(() => process.kill(childPid, 0)).toThrow()
  }, 30_000)
})
