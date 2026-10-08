import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import { ghExecFileAsync } from '../git/command-runner/gh-exec-file'
import { glabExecFileAsync } from '../git/command-runner/glab-exec-file'
import { execFileCaptureToTermination } from '../git/command-runner/exec-file-capture'
import { beginLocalCommandSelection, resolveSelectedLocalCommand } from './command-path-resolver'
import {
  execLocalPreflightCommandOrThrow,
  findRunnableLocalCommand,
  shellQuote
} from './preflight-command-exec'

vi.mock('../../shared/system-cli-install-dirs', () => ({
  getSystemCliInstallDirectories: (_platform: NodeJS.Platform, home: string) => [
    path.join(home, '.nix-profile', 'bin')
  ]
}))

let root = ''
const CLIS = ['gh', 'glab'] as const

async function fixtureCli(
  cli: string,
  label: string,
  body = `case "$1" in\n--version) echo fixture-version;;\nauth) echo 'Logged in fixture';;\napi) echo '${label}-api';;\nesac\n`
): Promise<string> {
  const dir = path.join(root, label)
  await mkdir(dir, { recursive: true })
  const binary = path.join(dir, cli)
  await writeFile(
    binary,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(`${binary}-calls`)}\n${body}`,
    { mode: 0o755 }
  )
  return binary
}

async function calls(binary: string): Promise<string[]> {
  try {
    return (await readFile(`${binary}-calls`, 'utf8')).trim().split('\n')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return []
    }
    throw error
  }
}

function providerCommand(cli: 'gh' | 'glab', env?: NodeJS.ProcessEnv, cwd?: string) {
  const execute = cli === 'gh' ? ghExecFileAsync : glabExecFileAsync
  return execute(['api', 'user'], { timeout: 1000, idempotent: false, env, cwd })
}

describe.skipIf(process.platform === 'win32')(
  'preflight selection in native provider commands',
  () => {
    beforeEach(async () => {
      root = await mkdtemp(path.join(tmpdir(), 'orca-22975-provider-'))
      vi.stubEnv('HOME', root)
    })

    afterEach(async () => {
      vi.unstubAllEnvs()
      await removeTree(root)
    })

    it.each(CLIS)(
      'uses the same runnable %s for version, auth and provider operations',
      async (cli) => {
        const shim = await fixtureCli(cli, 'shim', 'echo broken-shim >&2\nexit 126\n')
        const good = await fixtureCli(cli, 'good')
        vi.stubEnv('PATH', [path.dirname(shim), path.dirname(good)].join(path.delimiter))

        const selected = await findRunnableLocalCommand(cli)
        expect(selected).toEqual({ status: 'available', binary: good })
        if (selected.status !== 'available') {
          throw new Error('Expected the working fixture to be selected')
        }
        await expect(
          execLocalPreflightCommandOrThrow(selected.binary, ['auth', 'status'])
        ).resolves.toMatchObject({ stdout: 'Logged in fixture\n' })
        await expect(providerCommand(cli, undefined, root)).resolves.toMatchObject({
          stdout: 'good-api\n'
        })
        expect(await calls(shim)).toEqual(['--version'])
        expect(await calls(good)).toEqual(['--version', 'auth status', 'api user'])
      }
    )

    it.each(CLIS)(
      'keeps the proven %s usable while its version selection refreshes',
      async (cli) => {
        const shim = await fixtureCli(cli, 'shim', 'echo broken-shim >&2\nexit 126\n')
        const good = await fixtureCli(cli, 'good')
        vi.stubEnv('PATH', [path.dirname(shim), path.dirname(good)].join(path.delimiter))
        await findRunnableLocalCommand(cli)

        const refreshing = findRunnableLocalCommand(cli)
        await expect(providerCommand(cli)).resolves.toMatchObject({ stdout: 'good-api\n' })
        await expect(refreshing).resolves.toEqual({ status: 'available', binary: good })
        expect(await calls(shim)).toEqual(['--version', '--version'])
      }
    )

    it('clears the previous selection only after the newest version probe fails', async () => {
      const shim = await fixtureCli('gh', 'shim', 'exit 126\n')
      const good = await fixtureCli(
        'gh',
        'good',
        'if [ "$1" = --version ] && [ "$ORCA_22975_VERSION_DISABLED" = 1 ]; then exit 126; fi\necho good-api\n'
      )
      vi.stubEnv('PATH', [path.dirname(shim), path.dirname(good)].join(path.delimiter))
      await findRunnableLocalCommand('gh')
      vi.stubEnv('ORCA_22975_VERSION_DISABLED', '1')

      const refreshing = findRunnableLocalCommand('gh')
      await expect(providerCommand('gh')).resolves.toMatchObject({ stdout: 'good-api\n' })
      await expect(refreshing).resolves.toMatchObject({ status: 'exec_failed' })
      expect(resolveSelectedLocalCommand('gh')).toBe('gh')
    })

    it.each(CLIS)('also uses the recovered %s from a known install directory', async (cli) => {
      const shim = await fixtureCli(cli, 'shim', 'exit 126\n')
      const good = await fixtureCli(cli, path.join('.nix-profile', 'bin'))
      vi.stubEnv('PATH', path.dirname(shim))

      await expect(findRunnableLocalCommand(cli)).resolves.toEqual({
        status: 'available',
        binary: good
      })
      await expect(providerCommand(cli)).resolves.toMatchObject({
        stdout: `${path.join('.nix-profile', 'bin')}-api\n`
      })
      expect(await calls(shim)).toEqual(['--version'])
    })

    it.each(CLIS)('keeps %s selected when authentication fails', async (cli) => {
      const first = await fixtureCli(
        cli,
        'first',
        'if [ "$1" = auth ]; then echo unauthenticated >&2; exit 1; fi\necho first-result\n'
      )
      const other = await fixtureCli(cli, 'other')
      vi.stubEnv('PATH', [path.dirname(first), path.dirname(other)].join(path.delimiter))

      await findRunnableLocalCommand(cli)
      await expect(
        execLocalPreflightCommandOrThrow(first, ['auth', 'status'])
      ).rejects.toMatchObject({
        code: 1
      })
      await expect(providerCommand(cli)).resolves.toMatchObject({ stdout: 'first-result\n' })
      expect(await calls(other)).toEqual([])
    })

    it.each(CLIS)('never retries a failed %s operation on another binary', async (cli) => {
      const first = await fixtureCli(
        cli,
        'first',
        'if [ "$1" = api ]; then echo operation-failed >&2; exit 126; fi\necho fixture-version\n'
      )
      const other = await fixtureCli(cli, 'other')
      vi.stubEnv('PATH', [path.dirname(first), path.dirname(other)].join(path.delimiter))

      await findRunnableLocalCommand(cli)
      await expect(providerCommand(cli)).rejects.toMatchObject({
        code: 126,
        stderr: 'operation-failed\n'
      })
      expect(await calls(first)).toEqual(['--version', 'api user'])
      expect(await calls(other)).toEqual([])
    })

    it('respects a caller PATH and explicit binary instead of the global selection', async () => {
      const shim = await fixtureCli('gh', 'shim', 'exit 126\n')
      const good = await fixtureCli('gh', 'good')
      const custom = await fixtureCli('gh', 'custom')
      vi.stubEnv('PATH', [path.dirname(shim), path.dirname(good)].join(path.delimiter))
      await findRunnableLocalCommand('gh')
      const refreshing = findRunnableLocalCommand('gh')

      await expect(
        providerCommand('gh', { ...process.env, PATH: path.dirname(custom) })
      ).resolves.toMatchObject({ stdout: 'custom-api\n' })
      await expect(
        execFileCaptureToTermination(custom, ['api', 'user'], { encoding: 'utf8', timeout: 1000 })
      ).resolves.toMatchObject({ stdout: 'custom-api\n' })
      await expect(providerCommand('gh')).resolves.toMatchObject({ stdout: 'good-api\n' })
      await expect(refreshing).resolves.toEqual({ status: 'available', binary: good })
    })

    it('bypasses a selection after PATH or relative-PATH cwd changes', async () => {
      const good = await fixtureCli('gh', 'good')
      const custom = await fixtureCli('gh', 'custom')
      vi.stubEnv('PATH', path.dirname(good))
      await findRunnableLocalCommand('gh')
      const refreshing = findRunnableLocalCommand('gh')
      vi.stubEnv('PATH', path.dirname(custom))
      await expect(providerCommand('gh')).resolves.toMatchObject({ stdout: 'custom-api\n' })
      await refreshing
      await expect(providerCommand('gh')).resolves.toMatchObject({ stdout: 'custom-api\n' })

      vi.stubEnv('PATH', path.relative(process.cwd(), path.dirname(good)))
      await findRunnableLocalCommand('gh')
      expect(resolveSelectedLocalCommand('gh', { cwd: root })).toBe('gh')
    })

    it('discards a replaced binary and clears a selection when the next probe fails', async () => {
      const shim = await fixtureCli('gh', 'shim', 'exit 126\n')
      const good = await fixtureCli('gh', 'good')
      vi.stubEnv('PATH', [path.dirname(shim), path.dirname(good)].join(path.delimiter))
      await findRunnableLocalCommand('gh')
      await writeFile(good, '#!/bin/sh\necho changed >&2\nexit 126\n')

      expect(resolveSelectedLocalCommand('gh')).toBe('gh')
      await expect(findRunnableLocalCommand('gh')).resolves.toMatchObject({ status: 'exec_failed' })
      expect(resolveSelectedLocalCommand('gh')).toBe('gh')
      await fixtureCli('gh', 'good')
      await findRunnableLocalCommand('gh')
      expect(resolveSelectedLocalCommand('gh')).toBe(good)
      await rm(good)
      expect(resolveSelectedLocalCommand('gh')).toBe('gh')
    })

    it('keeps an older concurrent probe from replacing the newer selection', async () => {
      const first = await fixtureCli('gh', 'first')
      const second = await fixtureCli('gh', 'second')
      const older = beginLocalCommandSelection('gh')
      const newer = beginLocalCommandSelection('gh')
      await newer(second)
      await older(first)
      await older(null)

      expect(resolveSelectedLocalCommand('gh')).toBe(second)
    })
  }
)

describe('Windows selection across working folders', () => {
  it('keeps an absolute PATH selection in a different provider cwd', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orca-22975-cwd-'))
    const binary = path.join(directory, 'gh.CMD')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    await writeFile(binary, '@echo off\r\nexit /b 0\r\n')
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.stubEnv('PATH', directory)
      const publish = beginLocalCommandSelection('gh')
      await publish(binary)
      expect(resolveSelectedLocalCommand('gh', { cwd: path.join(directory, 'project') })).toBe(
        binary
      )
    } finally {
      vi.unstubAllEnvs()
      if (descriptor) {
        Object.defineProperty(process, 'platform', descriptor)
      }
      await removeTree(directory)
    }
  })

  it('does not carry a current-directory CLI into another folder', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'orca-22975-local-cwd-'))
    const binary = path.join(directory, 'gh.CMD')
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    await writeFile(binary, '@echo off\r\nexit /b 0\r\n')
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(directory)
    try {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      vi.stubEnv('PATH', path.join(directory, 'other'))
      const publish = beginLocalCommandSelection('gh')
      await publish(binary)
      expect(resolveSelectedLocalCommand('gh')).toBe(binary)
      expect(resolveSelectedLocalCommand('gh', { cwd: path.join(directory, 'project') })).toBe('gh')
    } finally {
      cwd.mockRestore()
      vi.unstubAllEnvs()
      if (descriptor) {
        Object.defineProperty(process, 'platform', descriptor)
      }
      await removeTree(directory)
    }
  })
})

describe.runIf(process.platform === 'win32')('native provider batch selection', () => {
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'orca-22975-provider-cmd-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await removeTree(root)
  })

  it.each(CLIS)('passes the selected %s.cmd through the native runner', async (cli) => {
    const shim = path.join(root, 'shim')
    const good = path.join(root, 'good')
    await mkdir(shim)
    await mkdir(good)
    await writeFile(path.join(shim, `${cli}.CMD`), '@echo off\r\nexit /b 126\r\n')
    await writeFile(
      path.join(good, `${cli}.CMD`),
      '@echo off\r\nif "%~1"=="api" (echo good-api) else (echo fixture-version)\r\nexit /b 0\r\n'
    )
    vi.stubEnv('PATH', [shim, good].join(path.delimiter))
    vi.stubEnv('Path', [shim, good].join(path.delimiter))
    vi.stubEnv('PATHEXT', '.CMD')

    await expect(findRunnableLocalCommand(cli)).resolves.toEqual({
      status: 'available',
      binary: path.posix.join(good, `${cli}.CMD`)
    })
    await expect(providerCommand(cli, undefined, root)).resolves.toMatchObject({
      stdout: expect.stringContaining('good-api')
    })
  })
})
