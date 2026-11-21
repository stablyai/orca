import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readOptional, readRefFile, UNRESOLVED_HEAD } from './git-dir-branch-state'

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
    await expect(readOptional(join(root, 'to-fifo'))).rejects.toThrow('Not a small regular file')
  }
)
