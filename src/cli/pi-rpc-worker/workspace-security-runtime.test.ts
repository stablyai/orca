import { access, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WORKSPACE_FILE_MAX_BYTES,
  canonicalWorkspaceRoot,
  listWorkspaceEntries,
  readWorkspaceText,
  resolveWorkspacePath
} from './workspace-security-runtime'
import {
  applyExactWorkspaceEdits,
  editWorkspaceText,
  writeWorkspaceText
} from './workspace-mutation-runtime'

const cleanup: string[] = []

async function fixture(): Promise<{ parent: string; root: string; outside: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'orca-secure-workspace-'))
  cleanup.push(parent)
  const root = join(parent, 'workspace')
  const outside = join(parent, 'outside')
  await mkdir(root)
  await mkdir(outside)
  return { parent, root: await canonicalWorkspaceRoot(root), outside }
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('secure Pi workspace file operations', () => {
  it('rejects absolute, Windows-absolute, traversal, NUL, and oversized paths', async () => {
    const { root } = await fixture()
    for (const hostile of [
      '/etc/passwd',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      '../outside/secret.txt',
      'bad\0name',
      'a'.repeat(1025)
    ]) {
      expect(() => resolveWorkspacePath(root, hostile)).toThrow('rejected')
    }
    expect(resolveWorkspacePath(root, 'src/file.ts')).toBe(join(root, 'src/file.ts'))
  })

  it('reads only bounded single-link regular UTF-8 files', async () => {
    const { root, outside } = await fixture()
    await writeFile(join(root, 'safe.txt'), 'hello')
    await writeFile(join(root, 'binary.bin'), Buffer.from([0xff, 0xfe]))
    await writeFile(join(root, 'large.txt'), Buffer.alloc(WORKSPACE_FILE_MAX_BYTES + 1, 0x61))
    await writeFile(join(outside, 'hardlink-source.txt'), 'outside')
    await link(join(outside, 'hardlink-source.txt'), join(root, 'hardlink.txt'))

    await expect(readWorkspaceText(root, 'safe.txt')).resolves.toBe('hello')
    await expect(readWorkspaceText(root, 'binary.bin')).rejects.toThrow('UTF-8')
    await expect(readWorkspaceText(root, 'large.txt')).rejects.toThrow('byte limit')
    await expect(readWorkspaceText(root, 'hardlink.txt')).rejects.toThrow('single-link')
    await expect(readWorkspaceText(root, '.')).rejects.toThrow('rejected')
  })

  it('rejects symlinked parents before reads or writes can escape', async () => {
    const { root, outside } = await fixture()
    await writeFile(join(outside, 'secret.txt'), 'secret')
    await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(readWorkspaceText(root, 'linked/secret.txt')).rejects.toThrow('link')
    await expect(writeWorkspaceText(root, 'linked/created.txt', 'escape')).rejects.toThrow('link')
    await expect(access(join(outside, 'created.txt'))).rejects.toThrow()
  })

  it('atomically writes new and existing files but refuses hardlink targets', async () => {
    const { root, outside } = await fixture()
    await writeWorkspaceText(root, 'new.txt', 'new content')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('new content')
    await writeWorkspaceText(root, 'new.txt', 'replacement')
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('replacement')

    await writeFile(join(outside, 'shared.txt'), 'outside content')
    await link(join(outside, 'shared.txt'), join(root, 'shared.txt'))
    await expect(writeWorkspaceText(root, 'shared.txt', 'overwrite')).rejects.toThrow('single-link')
    expect(await readFile(join(outside, 'shared.txt'), 'utf8')).toBe('outside content')
  })

  it('applies only unique non-overlapping exact edits and commits atomically', async () => {
    const { root } = await fixture()
    await writeFile(join(root, 'code.ts'), 'const first = 1\nconst second = 2\n')
    await editWorkspaceText(root, 'code.ts', [
      { oldText: 'first = 1', newText: 'first = 10' },
      { oldText: 'second = 2', newText: 'second = 20' }
    ])
    expect(await readFile(join(root, 'code.ts'), 'utf8')).toBe(
      'const first = 10\nconst second = 20\n'
    )
    expect(() =>
      applyExactWorkspaceEdits('repeat repeat', [{ oldText: 'repeat', newText: 'changed' }])
    ).toThrow('exactly once')
    expect(() =>
      applyExactWorkspaceEdits('abcdef', [
        { oldText: 'abcd', newText: 'x' },
        { oldText: 'cdef', newText: 'y' }
      ])
    ).toThrow('overlap')
  })

  it('bounds directory items and marks link, hardlink, and non-regular entries blocked', async () => {
    const { root, outside } = await fixture()
    await writeFile(join(root, 'file.txt'), 'file')
    await mkdir(join(root, 'directory'))
    await writeFile(join(outside, 'linked.txt'), 'linked')
    await link(join(outside, 'linked.txt'), join(root, 'hardlink.txt'))
    await symlink(outside, join(root, 'symlink'), process.platform === 'win32' ? 'junction' : 'dir')

    const result = await listWorkspaceEntries(root, '.', 10)
    expect(result.entries).toEqual(
      expect.arrayContaining([
        { name: 'file.txt', kind: 'file' },
        { name: 'directory', kind: 'directory' },
        { name: 'hardlink.txt', kind: 'blocked' },
        { name: 'symlink', kind: 'blocked' }
      ])
    )
    const bounded = await listWorkspaceEntries(root, '.', 2)
    expect(bounded.entries).toHaveLength(2)
    expect(bounded.truncated).toBe(true)
  })
})
