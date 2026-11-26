import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { readGitCommonHeadIdentities } from './worktree-head-identity-reader'

const readIdentities = async (
  ...args: Parameters<typeof readGitCommonHeadIdentities>
): Promise<Awaited<ReturnType<typeof readGitCommonHeadIdentities>>['identities']> =>
  (await readGitCommonHeadIdentities(...args)).identities

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

  it('reads loose and packed HEAD refs for primary and linked worktrees', async () => {
    const commonDir = await makeCommonDir()
    await writeFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeLooseRef(commonDir, 'refs/heads/main', OID_A)
    await writeLooseRef(commonDir, 'refs/heads/relative', OID_B)
    await writeFile(
      join(commonDir, 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${OID_C} refs/heads/feature\n^${OID_A}\n${OID_C} refs/heads/main\n`
    )
    const linkedPath = join(dirname(commonDir), '..', 'linked-wt')
    await addLinkedWorktree(commonDir, 'linked-wt', linkedPath, 'ref: refs/heads/feature')
    const relative = join(commonDir, 'worktrees', 'rel-wt')
    await mkdir(relative, { recursive: true })
    await writeFile(join(relative, 'HEAD'), 'ref: refs/heads/relative\n')
    await writeFile(join(relative, 'gitdir'), `${join('..', '..', '..', '..', 'rel-wt', '.git')}\n`)

    const identities = await readIdentities(commonDir)

    expect(identities).toContainEqual({
      worktreePath: dirname(commonDir),
      head: OID_A,
      branch: 'refs/heads/main'
    })
    expect(identities).toContainEqual({
      worktreePath: linkedPath,
      head: OID_C,
      branch: 'refs/heads/feature'
    })
    expect(identities).toContainEqual({
      worktreePath: join(dirname(commonDir), '..', 'rel-wt'),
      head: OID_B,
      branch: 'refs/heads/relative'
    })
  })

  it('rejects traversal-shaped symrefs instead of reading outside the common dir', async () => {
    const commonDir = await makeCommonDir()
    // Crafted HEAD ref names must not traverse through Windows backslash separators.
    await writeFile(join(dirname(commonDir), '..', 'outside.txt'), 'secret\n')
    for (const ref of [
      'refs/heads/../../../outside.txt',
      'refs\\..\\..\\..\\outside.txt',
      'refs/heads/evil:name',
      'refs//heads'
    ]) {
      await writeFile(join(commonDir, 'HEAD'), `ref: ${ref}\n`)
      expect(await readIdentities(commonDir)).toEqual([])
    }
  })
})
