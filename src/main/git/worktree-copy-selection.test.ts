import * as executor from '../ipc/worktree-symlinks'
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '../../shared/child-process/run-process'
import { materializeHostWorktreePaths } from '../ipc/worktree-path-materialization'
import { collapseWorktreePaths, resolveWorktreeCopySelection } from './worktree-copy-selection'
import { isWorktreeCopyPath } from '../../shared/worktree-copy-paths'

vi.mock('../ipc/worktree-copy-on-write-backend', () => ({ resolveCopyOnWriteBackend: () => null }))
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-copy-selection-'))
  roots.push(root)
  const source = join(root, 'source'),
    target = join(root, 'target')
  await mkdir(source)
  await mkdir(target)
  expect((await runProcess({ program: 'git', args: ['init', '-q', source] })).code).toBe(0)
  await writeFile(join(source, '.gitignore'), '.env\n.env.local\ncache/\n')
  await writeFile(join(source, '.worktreeinclude'), '.env\ncache/\n')
  await writeFile(join(source, '.env'), 'source')
  await writeFile(join(source, '.env.local'), 'personal')
  await mkdir(join(source, 'cache'))
  await writeFile(join(source, 'cache', 'entry'), 'cached')
  return { source, target }
}

describe('repository and project copy selection', () => {
  it('reports project paths beyond the manifest limit', async () => {
    const { source } = await fixture()
    await writeFile(
      join(source, '.worktreeinclude'),
      Array.from({ length: 1002 }, (_, i) => `absent-${i}`).join('\n')
    )
    expect((await resolveWorktreeCopySelection(source, [])).notices).toContain(
      '2 .worktreeinclude entries exceeded the 1,000-path limit and were skipped.'
    )
  })
  it('copies the union privately without CoW, collapses children, and preserves existing destinations', async () => {
    const { source, target } = await fixture()
    expect(
      (await resolveWorktreeCopySelection(source, ['.env', '.env.local', 'cache/entry'])).paths
    ).toEqual(['.env', 'cache', '.env.local'])
    await writeFile(join(target, '.env'), 'destination')
    await materializeHostWorktreePaths(source, target, [], undefined, ['.env.local', 'cache/entry'])
    expect(await readFile(join(target, '.env'), 'utf8')).toBe('destination')
    expect((await lstat(join(target, '.env.local'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(target, 'cache', 'entry'), 'utf8')).toBe('cached')
    await writeFile(join(target, '.env.local'), 'changed')
    expect(await readFile(join(source, '.env.local'), 'utf8')).toBe('personal')
  })
  it('rejects copy/share and copy/legacy overlaps before any writes', async () => {
    const { source, target } = await fixture()
    await expect(
      materializeHostWorktreePaths(source, target, ['cache/entry'], undefined, [])
    ).rejects.toThrow('overlaps')
    expect(await readdir(target)).toEqual([])
    await writeFile(join(source, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - cache\n')
    await expect(materializeHostWorktreePaths(source, target, [], undefined, [])).rejects.toThrow(
      'overlaps'
    )
    expect(await readdir(target)).toEqual([])
  })
  it('reports missing selections but rejects nonignored paths and invalid manifests', async () => {
    const { source, target } = await fixture()
    expect(await materializeHostWorktreePaths(source, target, [], undefined, ['absent'])).toContain(
      'absent: nothing to copy'
    )
    await writeFile(join(source, 'scratch'), 'untracked')
    await expect(resolveWorktreeCopySelection(source, ['scratch'])).rejects.toThrow(
      'ignored by Git'
    )
    await writeFile(join(source, '.worktreeinclude'), '**/.env')
    const result = await resolveWorktreeCopySelection(source, [])
    expect(result.paths).toEqual([])
    expect(result.notices.join(' ')).toContain('unsupported .worktreeinclude')
  })
  it('uses one copy call and stops setup preparation on possible partial output', async () => {
    const { source, target } = await fixture()
    const copy = vi
      .spyOn(executor, 'createWorktreeCopiedPaths')
      .mockResolvedValue([{ path: '.env', reason: 'failed', mayBePartial: true }])
    await expect(
      materializeHostWorktreePaths(source, target, [], undefined, ['.env.local'])
    ).rejects.toThrow('setup was not prepared')
    expect(copy).toHaveBeenCalledExactlyOnceWith(source, target, ['.env', 'cache', '.env.local'])
  })
  it('reports a clean budget refusal without switching to sharing', async () => {
    const { source, target } = await fixture()
    vi.spyOn(executor, 'createWorktreeCopiedPaths').mockResolvedValue([
      { path: '.env.local', reason: 'entries' }
    ])
    const warning = await materializeHostWorktreePaths(source, target, [], undefined, [
      '.env.local'
    ])
    expect(warning).toContain('.env.local')
    expect(warning).toContain('Files to copy')
    expect(warning).not.toContain('.worktreeinclude')
    expect(await readdir(target)).toEqual([])
  })

  it('bounds warnings for large missing selections', async () => {
    const { source } = await fixture()
    const paths = Array.from({ length: 1000 }, (_, i) => `missing-${i}`)
    const { notices } = await resolveWorktreeCopySelection(source, paths)
    expect(notices).toHaveLength(6)
    expect(notices.at(-1)).toBe('995 more selected paths were absent.')
    expect(notices.join(' ').length).toBeLessThan(1024)
  })

  it('keeps similarly named siblings and rejects unsafe portable path spellings', () => {
    expect(collapseWorktreePaths('/repo', ['cache/a', 'cache', 'cache-other'])).toEqual([
      'cache',
      'cache-other'
    ])
    for (const path of [
      '/etc/passwd',
      'C:secret',
      '../x',
      '..\\x',
      '\\server\\file',
      '.git/config',
      'x/.GIT /config',
      '!a',
      'a*',
      'a\0b'
    ]) {
      expect(isWorktreeCopyPath(path)).toBe(false)
    }
  })
})
