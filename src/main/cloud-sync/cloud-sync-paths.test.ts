import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cloudSyncFolder,
  displayPath,
  ensureSafeParent,
  folderSegment,
  hasSafeParents,
  isSafeSyncPath
} from './cloud-sync-paths'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('cloud sync paths', () => {
  it('puts a workspace at ~/orca/cloud/<repository>/<workspace>', () => {
    const folder = cloudSyncFolder(
      { repoName: 'Hello-World', workspaceName: 'my-ws', workspaceId: 'abc' },
      '/Users/me'
    )
    expect(folder).toBe('/Users/me/orca/cloud/Hello-World/my-ws')
    expect(displayPath(folder, '/Users/me')).toBe('~/orca/cloud/Hello-World/my-ws')
  })

  it('cleans names into single visible folder names', () => {
    expect(folderSegment('../../etc', 'x')).toBe('-..-etc')
    expect(folderSegment('.hidden', 'x')).toBe('hidden')
    expect(folderSegment('a/b:c', 'x')).toBe('a-b-c')
    expect(folderSegment('‮evil', 'x')).toBe('evil')
    expect(folderSegment('  ', 'fallback')).toBe('fallback')
  })

  it('accepts ordinary workspace paths', () => {
    for (const path of ['README.md', 'src/a.ts', '.context/plan.md', '.github/workflows/ci.yml']) {
      expect(isSafeSyncPath(path)).toBe(true)
    }
  })

  it('refuses anything that could land outside the folder or in git internals', () => {
    for (const path of [
      '',
      '/etc/passwd',
      '../x',
      'a/../../x',
      'a//b',
      './a',
      'a\\b',
      '.git/config',
      'sub/.git/hooks/pre-commit',
      '.orca-sync-tmp/x',
      'a\u0000b',
      'a‮b'
    ]) {
      expect(isSafeSyncPath(path)).toBe(false)
    }
  })

  it('never creates or follows a symlinked parent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cloud-sync-paths-'))
    const outside = await mkdtemp(join(tmpdir(), 'cloud-sync-outside-'))
    dirs.push(root, outside)
    await symlink(outside, join(root, 'link'))
    await expect(ensureSafeParent(root, 'link/file.txt')).rejects.toThrow('unsafe_parent')
    expect(await hasSafeParents(root, 'link/file.txt')).toBe(false)
    await mkdir(join(root, 'real'))
    expect(await ensureSafeParent(root, 'real/deeper/file.txt')).toBe(
      join(root, 'real', 'deeper', 'file.txt')
    )
    expect(await hasSafeParents(root, 'real/deeper/file.txt')).toBe(true)
  })
})
