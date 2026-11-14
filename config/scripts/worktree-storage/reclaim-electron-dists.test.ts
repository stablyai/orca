import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { getElectronPlatformPath } from '../electron-installation/platform-layout/electron-platform-path.mjs'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-reclaim-electron-'))
  roots.push(root)
  const result = await runProcess({
    program: 'git',
    args: ['init', '--quiet'],
    cwd: root,
    timeoutMs: 10_000,
    terminationBarrier: true
  })
  expect(result.code).toBe(0)
  const pkg = join(root, 'node_modules', 'electron')
  const executable = join(pkg, 'dist', getElectronPlatformPath(process.platform))
  await mkdir(join(executable, '..'), { recursive: true })
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ version: '99.1.0' }))
  await writeFile(join(pkg, 'dist', 'version'), '99.1.0\n')
  await writeFile(executable, 'fake electron executable\n')
  const run = (apply = false, flags: string[] = []) =>
    runProcess({
      program: process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.execPath,
      args: [
        resolve(import.meta.dirname, 'reclaim-electron-dists.mjs'),
        '--repo',
        root,
        ...(apply ? ['--apply'] : []),
        ...flags
      ],
      cwd: root,
      env: { ...process.env, CI: '', ORCA_BACKGROUND_LAUNCH: '1' },
      timeoutMs: 20_000,
      terminationBarrier: true
    })
  return { root, pkg, executable, run }
}

it.skipIf(process.platform === 'win32')(
  'reports a read-only package as protected in preview and apply',
  async () => {
    const { pkg, executable, run } = await fixture()
    await chmod(pkg, 0o555)
    try {
      for (const apply of [false, true]) {
        const result = await run(apply)
        expect(result.code, result.stderr).toBe(0)
        expect(result.stdout).toContain('Electron package directory is not writable')
        expect(result.stdout).toContain('0 worktree(s)')
        expect(result.stdout).toContain('skipped 1')
        expect(await readFile(executable, 'utf8')).toBe('fake electron executable\n')
        await expect(readFile(join(pkg, '.orca-shared-dist'))).rejects.toMatchObject({
          code: 'ENOENT'
        })
      }
    } finally {
      await chmod(pkg, 0o755)
    }
  }
)

it('protects the launching worktree, including when selected through a filesystem alias', async () => {
  const { root, pkg, executable, run } = await fixture()
  const alias = join(root, 'alias')
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  for (const exclusion of [root, alias]) {
    for (const apply of [false, true]) {
      const result = await run(apply, ['--exclude-worktree', exclusion])
      expect(result.code, result.stderr).toBe(0)
      expect(result.stdout).toContain('0 worktree(s)')
      expect(await readFile(executable, 'utf8')).toBe('fake electron executable\n')
      await expect(readFile(join(pkg, '.orca-shared-dist'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    }
  }
})

it('rejects a missing exclusion before changing an install', async () => {
  const flags = ['--exclude-worktree']
  const { pkg, run } = await fixture()
  const result = await run(true, flags)
  expect(result.code).not.toBe(0)
  expect(result.stderr).toContain('--exclude-worktree requires a directory')
  await expect(readFile(join(pkg, '.orca-shared-dist'))).rejects.toMatchObject({ code: 'ENOENT' })
})
