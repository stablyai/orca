import { randomBytes } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { serveRepositoriesOverTestSsh } from './__mocks__/plugin-git-ssh-remote-fixture'
import {
  checkoutPluginGitSource,
  pluginGitAllowedProtocols,
  runPluginGit
} from './plugin-git-repository'

const PLUGIN_URL = 'ssh://git@plugins.example.invalid/sample.git'
// Why not on Windows: the planted hooks are POSIX shell scripts; the no-checkout path is shared.
const PLANT_HOOKS = process.platform !== 'win32'
const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function nodeCommand(code: string): string {
  const encoded = Buffer.from(code).toString('base64')
  return `"${process.execPath.replaceAll('\\', '/')}" -e "eval(Buffer.from('${encoded}','base64').toString())"`
}

async function fixture(initArgs: string[] = []) {
  const root = await mkdtemp(join(tmpdir(), 'orca-plugin-git-'))
  roots.push(root)
  const repository = join(root, 'source')
  const destination = join(root, 'download')
  const config = join(root, 'config')
  const hooks = join(root, 'hooks')
  const filtered = join(root, 'filter-executed')
  const hooked = join(root, 'hook-executed')
  await mkdir(hooks)
  await writeFile(config, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', config)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  const configure = (key: string, value: string) =>
    runPluginGit(['config', '--file', config, key, value], root)
  // Why a user-level allow: proves the plugin download's own protocol policy outranks it.
  await configure('protocol.file.allow', 'always')
  await configure('core.hooksPath', hooks)
  await serveRepositoriesOverTestSsh(root, { '/sample.git': repository })
  await runPluginGit(['init', '--quiet', '--template=', ...initArgs, repository], root)
  const git = (args: string[]) => runPluginGit(args, repository)
  await git(['config', 'user.name', 'Plugin fixture'])
  await git(['config', 'user.email', 'plugins@example.invalid'])
  const bytes = Buffer.from([0, 255, 13, 10, 65, 0, 128])
  await writeFile(join(repository, 'data.bin'), bytes)
  await writeFile(join(repository, '.gitattributes'), '*.bin filter=plugin-test\n')
  await git(['add', '--all'])
  await git(['commit', '--quiet', '-m', 'Exact source bytes'])
  await git(['tag', 'v1'])
  // Planted after the fixture commit so only the download under test can trigger them.
  const smudge = `require('node:fs').writeFileSync(${JSON.stringify(filtered)},'1');process.stdin.pipe(process.stdout)`
  await configure('filter.plugin-test.smudge', nodeCommand(smudge))
  for (const hook of PLANT_HOOKS ? ['post-checkout', 'reference-transaction'] : []) {
    await writeFile(
      join(hooks, hook),
      `#!/bin/sh\n${nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(hooked)},'1')`)}\n`,
      { mode: 0o755 }
    )
  }
  const checkout = (ref: string, url = PLUGIN_URL, maxDownloadBytes?: number) =>
    checkoutPluginGitSource({
      url,
      ref,
      destination,
      workingDirectory: root,
      ...(maxDownloadBytes ? { maxDownloadBytes } : {})
    })
  return { root, destination, bytes, filtered, hooked, git, checkout, configure, repository }
}

it.each(['tag', 'exact commit'])(
  'materializes exact bytes through a %s without hooks or smudge filters',
  async (mode) => {
    const f = await fixture()
    const commit = await f.git(['rev-parse', 'HEAD'])
    expect(await f.checkout(mode === 'tag' ? 'v1' : commit)).toBe(commit)
    expect(await readFile(join(f.destination, 'data.bin'))).toEqual(f.bytes)
    await expect(access(f.filtered)).rejects.toThrow()
    if (PLANT_HOOKS) {
      await expect(access(f.hooked)).rejects.toThrow()
    }
    expect(await readdir(f.destination)).not.toContain('.git')
  }
)

it.each([
  ['file', (repository: string) => pathToFileURL(repository).href],
  ['http', () => 'http://127.0.0.1:9/sample.git'],
  ['acme', () => 'acme::sample']
])('refuses a %s transport reached through an insteadOf rewrite', async (name, target) => {
  const f = await fixture()
  const url = 'https://plugins.example.invalid/rewritten.git'
  // Why a user-level allow: a custom remote helper must stay refused even when the user allows it.
  await f.configure(`protocol.${name}.allow`, 'always')
  await f.configure(`url.${target(f.repository)}.insteadOf`, url)
  // Why this also covers redirects: Git hands the same allowlist to curl's redirect protocols.
  await expect(f.checkout('v1', url)).rejects.toThrow(`transport '${name}' not allowed`)
})

it('rejects symlink objects before writing any file', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'link-target'), '../outside.txt')
  const object = await f.git(['hash-object', '-w', join(f.root, 'link-target')])
  await f.git(['update-index', '--add', '--cacheinfo', `120000,${object},link`])
  await f.git(['commit', '--quiet', '-m', 'Symbolic link'])
  await expect(f.checkout(await f.git(['rev-parse', 'HEAD']))).rejects.toThrow('symlinks')
  expect(await readdir(f.destination)).toEqual([])
})

it('aborts a download that grows past its size limit', async () => {
  const f = await fixture()
  await writeFile(join(f.root, 'source', 'large.bin'), randomBytes(4 * 1024 * 1024))
  await f.git(['add', 'large.bin'])
  await f.git(['commit', '--quiet', '-m', 'Large'])
  await expect(f.checkout('', PLUGIN_URL, 1024 * 1024)).rejects.toThrow(
    'exceeds the download size limit'
  )
  expect(await readdir(f.destination)).toEqual([])
})

it('rejects SHA-256 repositories', async () => {
  const f = await fixture(['--object-format=sha256']).catch(() => null)
  if (!f) {
    return // Git before 2.29 cannot create the fixture.
  }
  await expect(f.checkout('v1')).rejects.toThrow('SHA-256 plugin repositories are not supported')
  await expect(f.checkout('a'.repeat(64))).rejects.toThrow('SHA-256')
})

it('only narrows an inherited Git protocol allowlist', () => {
  expect(pluginGitAllowedProtocols(undefined)).toBe('https:ssh')
  expect(pluginGitAllowedProtocols('https:file:ext')).toBe('https')
  expect(pluginGitAllowedProtocols('')).toBe('')
})
