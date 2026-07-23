import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  MAX_GIT_HEAD_METADATA_BYTES,
  MAX_LINKED_WORKTREE_ENTRIES,
  MAX_PACKED_REFS_BYTES,
  readGitCommonHeadIdentities
} from './worktree-head-identity-reader'

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)

describe('readGitCommonHeadIdentities', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function makeCommonDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-head-reader-'))
    roots.push(root)
    const commonDir = join(root, 'checkout', '.git')
    await mkdir(commonDir, { recursive: true })
    return commonDir
  }

  async function writeLooseRef(commonDir: string, ref: string, oid: string): Promise<void> {
    const refPath = join(commonDir, ...ref.split('/'))
    await mkdir(dirname(refPath), { recursive: true })
    await writeFile(refPath, `${oid}\n`)
  }

  async function addLinkedWorktree(
    commonDir: string,
    name: string,
    worktreePath: string,
    headContent: string
  ): Promise<void> {
    const entry = join(commonDir, 'worktrees', name)
    await mkdir(entry, { recursive: true })
    await writeFile(join(entry, 'HEAD'), `${headContent}\n`)
    await writeFile(join(entry, 'gitdir'), `${join(worktreePath, '.git')}\n`)
  }

  it('resolves the primary checkout and linked worktrees from loose refs', async () => {
    const commonDir = await makeCommonDir()
    await writeFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeLooseRef(commonDir, 'refs/heads/main', OID_A)
    await writeLooseRef(commonDir, 'refs/heads/feature', OID_B)
    const linkedPath = join(dirname(commonDir), '..', 'linked-wt')
    await addLinkedWorktree(commonDir, 'linked-wt', linkedPath, 'ref: refs/heads/feature')

    const identities = await readGitCommonHeadIdentities(commonDir)

    expect(identities).toContainEqual({
      worktreePath: dirname(commonDir),
      head: OID_A,
      branch: 'refs/heads/main'
    })
    expect(identities).toContainEqual({
      worktreePath: linkedPath,
      head: OID_B,
      branch: 'refs/heads/feature'
    })
  })

  it('falls back to packed-refs when the loose ref is absent', async () => {
    const commonDir = await makeCommonDir()
    await writeFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeFile(
      join(commonDir, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${OID_C} refs/heads/main\n^${OID_A}\n`
    )

    const identities = await readGitCommonHeadIdentities(commonDir)

    expect(identities).toEqual([
      { worktreePath: dirname(commonDir), head: OID_C, branch: 'refs/heads/main' }
    ])
  })

  it('reports detached HEAD as a raw oid with a null branch', async () => {
    const commonDir = await makeCommonDir()
    await writeFile(join(commonDir, 'HEAD'), `${OID_B}\n`)

    const identities = await readGitCommonHeadIdentities(commonDir)

    expect(identities).toEqual([{ worktreePath: dirname(commonDir), head: OID_B, branch: null }])
  })

  it('skips unborn branches instead of emitting partial identities', async () => {
    const commonDir = await makeCommonDir()
    await writeFile(join(commonDir, 'HEAD'), 'ref: refs/heads/unborn\n')

    expect(await readGitCommonHeadIdentities(commonDir)).toEqual([])
  })

  it('resolves relative gitdir entries against the metadata dir', async () => {
    const commonDir = await makeCommonDir()
    await writeLooseRef(commonDir, 'refs/heads/feature', OID_B)
    const entry = join(commonDir, 'worktrees', 'rel-wt')
    await mkdir(entry, { recursive: true })
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/feature\n')
    await writeFile(join(entry, 'gitdir'), `${join('..', '..', '..', '..', 'rel-wt', '.git')}\n`)

    const identities = await readGitCommonHeadIdentities(commonDir)

    expect(identities).toEqual([
      {
        worktreePath: join(dirname(commonDir), '..', 'rel-wt'),
        head: OID_B,
        branch: 'refs/heads/feature'
      }
    ])
  })

  it('rejects traversal-shaped symrefs instead of reading outside the common dir', async () => {
    const commonDir = await makeCommonDir()
    // A crafted repo can put arbitrary content in HEAD; backslash segments
    // would traverse on Windows where join treats them as separators too.
    await writeFile(join(dirname(commonDir), '..', 'outside.txt'), 'secret\n')
    for (const ref of [
      'refs/heads/../../../outside.txt',
      'refs\\..\\..\\..\\outside.txt',
      'refs/heads/evil:name',
      'refs//heads'
    ]) {
      await writeFile(join(commonDir, 'HEAD'), `ref: ${ref}\n`)
      expect(await readGitCommonHeadIdentities(commonDir)).toEqual([])
    }
  })

  it('never emits resolved content that is not a hex object id', async () => {
    const commonDir = await makeCommonDir()
    await writeFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeLooseRef(commonDir, 'refs/heads/main', 'not-an-object-id')
    expect(await readGitCommonHeadIdentities(commonDir)).toEqual([])

    await writeFile(join(commonDir, 'HEAD'), 'this is not a detached oid\n')
    expect(await readGitCommonHeadIdentities(commonDir)).toEqual([])
  })

  it('omits the primary row for non-standard common dir layouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-head-reader-'))
    roots.push(root)
    const commonDir = join(root, 'bare-repo')
    await mkdir(commonDir, { recursive: true })
    await writeFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeLooseRef(commonDir, 'refs/heads/main', OID_A)

    expect(await readGitCommonHeadIdentities(commonDir)).toEqual([])
  })

  it('rejects metadata that grows beyond the exact file limits', async () => {
    const commonDir = await makeCommonDir()
    const headPath = join(commonDir, 'HEAD')
    await writeFile(headPath, 'x')
    await truncate(headPath, MAX_GIT_HEAD_METADATA_BYTES + 1)
    expect(await readGitCommonHeadIdentities(commonDir)).toEqual([])

    await writeFile(headPath, 'ref: refs/heads/main\n')
    const packedRefsPath = join(commonDir, 'packed-refs')
    await writeFile(packedRefsPath, 'x')
    await truncate(packedRefsPath, MAX_PACKED_REFS_BYTES + 1)
    expect(await readGitCommonHeadIdentities(commonDir)).toEqual([])
  })

  it('fails closed instead of retaining a partial oversized worktree listing', async () => {
    const commonDir = await makeCommonDir()
    await writeFile(join(commonDir, 'HEAD'), `${OID_A}\n`)
    const worktreesDir = join(commonDir, 'worktrees')
    await mkdir(worktreesDir)
    await Promise.all(
      Array.from({ length: MAX_LINKED_WORKTREE_ENTRIES + 1 }, (_, index) =>
        writeFile(join(worktreesDir, `entry-${index}`), '')
      )
    )

    expect(await readGitCommonHeadIdentities(commonDir)).toEqual([])
  })
})
