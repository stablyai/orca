import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  readGitDirState,
  readOptional,
  readRefFile,
  readRefLink,
  UNRESOLVED_HEAD
} from './git-dir-branch-state'
import { normalizeHead } from './git-ref-text'

let root: string | undefined

afterEach(async () => {
  await rm(root ?? '', { recursive: true, force: true })
})

// Windows has neither FIFOs nor unprivileged symlinks.
it.skipIf(process.platform === 'win32')(
  'refuses a ref or metadata file that is, or links to, a FIFO or an oversized file instead of reading it',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-ref-link-'))
    execFileSync('mkfifo', [join(root, 'fifo')])
    await writeFile(join(root, 'large'), `${'a'.repeat(40)}\n`.repeat(200))
    await symlink(join(root, 'fifo'), join(root, 'to-fifo'))
    await symlink(join(root, 'large'), join(root, 'to-large'))

    await expect(readRefFile(join(root, 'to-fifo'))).resolves.toBe(UNRESOLVED_HEAD)
    await expect(readRefFile(join(root, 'to-large'))).resolves.toBe(UNRESOLVED_HEAD)
    await expect(readRefFile(join(root, 'fifo'))).resolves.toBe(UNRESOLVED_HEAD)
    await expect(readRefFile(join(root, 'large'))).resolves.toBe(UNRESOLVED_HEAD)
    await expect(readOptional(join(root, 'to-fifo'))).rejects.toThrow('Not a readable regular file')
  }
)

it('reads rebase state larger than a gitfile may be', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-large-rebase-'))
  const rebase = join(root, 'worktrees', 'topic', 'rebase-merge')
  await mkdir(rebase, { recursive: true })
  await writeFile(join(root, 'HEAD'), 'ref: refs/heads/main\n')
  await writeFile(join(root, 'worktrees', 'topic', 'HEAD'), 'ref: refs/heads/topic\n')
  const lines = Array.from({ length: 11_000 }, (_, index) => `refs/heads/topic-${index}\n`)
  await writeFile(join(rebase, 'update-refs'), lines.join('').repeat(5))

  const state = await readGitDirState(root)

  expect(state.reserved.has('refs/heads/topic-10999')).toBe(true)
  expect(state.reserved.has('refs/heads/main')).toBe(false)
})

it('keeps a branch name ending in a no-break space, which Git allows', () => {
  expect(normalizeHead('ref:\trefs/heads/main\u00a0\r\n')).toBe('ref: refs/heads/main\u00a0')
})

// Windows itself needs symlink privileges; this stands in for its backslashed link targets.
it.skipIf(process.platform === 'win32')(
  'reads a backslashed Windows link target as the ref Git for Windows sees',
  async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-windows-link-'))
    await symlink('refs\\heads\\main', join(root, 'HEAD'))
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32' })
    try {
      await expect(readRefLink(join(root, 'HEAD'))).resolves.toBe('ref: refs/heads/main')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  }
)
