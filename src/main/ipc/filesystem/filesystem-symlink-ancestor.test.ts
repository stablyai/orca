import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasSymlinkBelowRoot } from './filesystem-symlink-ancestor'

describe('hasSymlinkBelowRoot', () => {
  let base: string

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'orca-symlink-ancestor-'))
    await mkdir(join(base, 'outside', 'Tasks', 'sub'), { recursive: true })
    await mkdir(join(base, 'workspace', 'Documents', 'real'), { recursive: true })
    // Why junction: Windows creates it without admin rights; POSIX ignores the type.
    await symlink(
      join(base, 'outside', 'Tasks'),
      join(base, 'workspace', 'Documents', 'Tasks'),
      'junction'
    )
    await symlink(join(base, 'workspace'), join(base, 'workspace-link'), 'junction')
  })

  afterEach(async () => {
    await rm(base, { recursive: true, force: true })
  })

  it('finds a linked folder between the root and the path', async () => {
    const root = join(base, 'workspace')
    await expect(hasSymlinkBelowRoot(root, join(root, 'Documents', 'Tasks'))).resolves.toBe(true)
    await expect(hasSymlinkBelowRoot(root, join(root, 'Documents', 'Tasks', 'sub'))).resolves.toBe(
      true
    )
  })

  it('ignores ordinary folders, including under a root that is itself a link', async () => {
    await expect(
      hasSymlinkBelowRoot(join(base, 'workspace'), join(base, 'workspace', 'Documents', 'real'))
    ).resolves.toBe(false)
    const linkedRoot = join(base, 'workspace-link')
    await expect(
      hasSymlinkBelowRoot(linkedRoot, join(linkedRoot, 'Documents', 'real'))
    ).resolves.toBe(false)
  })
})
