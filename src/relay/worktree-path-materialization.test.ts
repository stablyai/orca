import { mkdir, mkdtemp, readFile, lstat, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runProcess } from '../shared/child-process/run-process'
import { materializeRelayWorktreePaths } from './worktree-path-materialization'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('host-owned worktree path materialization', () => {
  it('reads host configuration and keeps shared paths ahead of overlapping includes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-relay-materialization-'))
    roots.push(root)
    const source = join(root, 'source')
    const target = join(root, 'target')
    await mkdir(source)
    await mkdir(target)
    const initialized = await runProcess({ program: 'git', args: ['init', '-q', source] })
    expect(initialized.code).toBe(0)
    await writeFile(join(source, '.gitignore'), '.env\nshared/\n')
    await writeFile(join(source, '.worktreeinclude'), '.env\nshared\n')
    await writeFile(join(source, '.env'), 'host-owned value')
    await mkdir(join(source, 'shared'))
    await writeFile(join(source, 'shared', 'marker'), 'shared')
    await writeFile(join(source, 'orca.yaml'), 'worktree:\n  sharedDirectories:\n    - shared\n')

    expect(await materializeRelayWorktreePaths({ source, target, linkedPaths: [] })).toEqual({
      supported: true
    })
    expect(await readFile(join(target, '.env'), 'utf8')).toBe('host-owned value')
    await writeFile(join(target, '.env'), 'private edit')
    expect(await readFile(join(source, '.env'), 'utf8')).toBe('host-owned value')
    expect((await lstat(join(target, 'shared'))).isSymbolicLink()).toBe(true)
    await writeFile(join(target, 'shared', 'marker'), 'shared edit')
    expect(await readFile(join(source, 'shared', 'marker'), 'utf8')).toBe('shared edit')
  })

  it('rejects malformed requests before touching any paths', async () => {
    await expect(
      materializeRelayWorktreePaths({ source: '.', target: '..', linkedPaths: [] })
    ).rejects.toThrow('Invalid')
    await expect(
      materializeRelayWorktreePaths({ source: '/a', target: '/b', linkedPaths: [7] })
    ).rejects.toThrow('Invalid')
  })
})
