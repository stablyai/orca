import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createWorktreeHeadIdentityCache,
  readGitCommonHeadIdentities,
  type WorktreeHeadIdentityCache
} from './worktree-head-identity-reader'
import {
  FULL_HEAD_IDENTITY_SCOPE,
  headIdentityScopeForEntry,
  LISTING_HEAD_IDENTITY_SCOPE,
  mergeHeadIdentityScopes,
  PRIMARY_HEAD_IDENTITY_SCOPE
} from './worktree-head-identity-scope'

const readIdentities = async (
  ...args: Parameters<typeof readGitCommonHeadIdentities>
): Promise<Awaited<ReturnType<typeof readGitCommonHeadIdentities>>['identities']> =>
  (await readGitCommonHeadIdentities(...args)).identities

const OID_A = 'a'.repeat(40)
const OID_B = 'b'.repeat(40)
const OID_C = 'c'.repeat(40)
const OID_D = 'd'.repeat(40)

describe('readGitCommonHeadIdentities (incremental)', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  async function writeLooseRef(commonDir: string, ref: string, oid: string): Promise<void> {
    const refPath = join(commonDir, ...ref.split('/'))
    await mkdir(dirname(refPath), { recursive: true })
    await writeFile(refPath, `${oid}\n`)
  }

  async function makeCommonDir(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'orca-head-incremental-'))
    roots.push(root)
    const commonDir = join(root, 'checkout', '.git')
    await mkdir(commonDir, { recursive: true })
    await writeFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
    await writeLooseRef(commonDir, 'refs/heads/main', OID_A)
    return commonDir
  }

  async function addLinkedWorktree(commonDir: string, name: string, head: string): Promise<string> {
    const entry = join(commonDir, 'worktrees', name)
    await mkdir(entry, { recursive: true })
    await writeFile(join(entry, 'HEAD'), `${head}\n`)
    const worktreePath = join(dirname(dirname(commonDir)), name)
    await mkdir(worktreePath, { recursive: true })
    await writeFile(join(entry, 'gitdir'), `${join(worktreePath, '.git')}\n`)
    return worktreePath
  }

  function headOf(
    identities: { worktreePath: string; head: string }[],
    worktreePath: string
  ): string | undefined {
    return identities.find((identity) => identity.worktreePath === worktreePath)?.head
  }

  async function seed(): Promise<{
    commonDir: string
    cache: WorktreeHeadIdentityCache
    pathA: string
    pathB: string
  }> {
    const commonDir = await makeCommonDir()
    await writeLooseRef(commonDir, 'refs/heads/feature-a', OID_B)
    await writeLooseRef(commonDir, 'refs/heads/feature-b', OID_C)
    const pathA = await addLinkedWorktree(commonDir, 'wt-a', 'ref: refs/heads/feature-a')
    const pathB = await addLinkedWorktree(commonDir, 'wt-b', 'ref: refs/heads/feature-b')
    const cache = createWorktreeHeadIdentityCache()
    const identities = await readIdentities(commonDir, cache)
    expect(identities).toHaveLength(3)
    expect(headOf(identities, pathA)).toBe(OID_B)
    expect(headOf(identities, pathB)).toBe(OID_C)
    return { commonDir, cache, pathA, pathB }
  }

  it('re-reads only the committing worktree and leaves the rest cached', async () => {
    const { commonDir, cache, pathA, pathB } = await seed()

    // Only wt-a is named by the event; wt-b must retain its cached branch identity.
    await writeLooseRef(commonDir, 'refs/heads/feature-a', OID_D)
    await writeLooseRef(commonDir, 'refs/heads/feature-b', OID_D)

    const scoped = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))
    expect(headOf(scoped, pathA)).toBe(OID_D)
    expect(headOf(scoped, pathB)).toBe(OID_C)

    const followUp = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-b'))
    expect(headOf(followUp, pathB)).toBe(OID_D)
  })

  it('picks up a branch switch through the entry scope', async () => {
    const { commonDir, cache, pathA } = await seed()
    await writeLooseRef(commonDir, 'refs/heads/other', OID_D)
    await writeFile(join(commonDir, 'worktrees', 'wt-a', 'HEAD'), 'ref: refs/heads/other\n')

    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))

    expect(identities).toContainEqual({
      worktreePath: pathA,
      head: OID_D,
      branch: 'refs/heads/other'
    })
  })

  it('adds an externally created worktree through the listing scope', async () => {
    const { commonDir, cache, pathA } = await seed()
    await writeLooseRef(commonDir, 'refs/heads/feature-c', OID_D)
    const pathC = await addLinkedWorktree(commonDir, 'wt-c', 'ref: refs/heads/feature-c')
    await writeLooseRef(commonDir, 'refs/heads/feature-a', OID_D)

    const identities = await readIdentities(commonDir, cache, LISTING_HEAD_IDENTITY_SCOPE)

    expect(headOf(identities, pathC)).toBe(OID_D)
    expect(headOf(identities, pathA)).toBe(OID_B)
  })

  it('re-reads an admin entry whose name was removed and immediately reused', async () => {
    const { commonDir, cache, pathA } = await seed()
    // Coalesced remove/add can reuse an admin name; a listing refresh alone cannot retain its identity.
    await rm(join(commonDir, 'worktrees', 'wt-a'), { recursive: true, force: true })
    await writeLooseRef(commonDir, 'refs/heads/reused', OID_D)
    const reusedPath = await addLinkedWorktree(commonDir, 'wt-a', 'ref: refs/heads/reused')

    const identities = await readIdentities(
      commonDir,
      cache,
      mergeHeadIdentityScopes(LISTING_HEAD_IDENTITY_SCOPE, headIdentityScopeForEntry('wt-a'))
    )

    expect(reusedPath).toBe(pathA)
    expect(identities).toContainEqual({
      worktreePath: reusedPath,
      head: OID_D,
      branch: 'refs/heads/reused'
    })
  })

  it('needs the full scope, not a narrow one, to survive a packed-refs rewrite', async () => {
    const { commonDir, cache, pathA, pathB } = await seed()
    // Packed-ref rewrites can move every branch with no per-worktree event.
    await rm(join(commonDir, 'refs', 'heads'), { recursive: true, force: true })
    await writeFile(
      join(commonDir, 'packed-refs'),
      [
        '# pack-refs with: peeled fully-peeled sorted',
        `${OID_D} refs/heads/main`,
        `${OID_D} refs/heads/feature-a`,
        `${OID_D} refs/heads/feature-b`,
        ''
      ].join('\n')
    )

    // A narrow read intentionally misses unnamed repacked branches, requiring packed-refs to use full scope.
    const narrow = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))
    expect(headOf(narrow, pathA)).toBe(OID_D)
    expect(headOf(narrow, pathB)).toBe(OID_C)

    const identities = await readIdentities(commonDir, cache, FULL_HEAD_IDENTITY_SCOPE)

    expect(headOf(identities, dirname(commonDir))).toBe(OID_D)
    expect(headOf(identities, pathA)).toBe(OID_D)
    expect(headOf(identities, pathB)).toBe(OID_D)
  })

  it('keeps a worktree whose checkout was deleted behind Orca back', async () => {
    const { commonDir, cache, pathA } = await seed()
    // Checkout absence is a prunable-listing concern; Git may retain its admin metadata.
    await rm(pathA, { recursive: true, force: true })

    const identities = await readIdentities(
      commonDir,
      cache,
      mergeHeadIdentityScopes(LISTING_HEAD_IDENTITY_SCOPE, headIdentityScopeForEntry('wt-a'))
    )

    expect(headOf(identities, pathA)).toBe(OID_B)
  })

  it('follows a branch shared by several worktrees without re-reading them', async () => {
    const commonDir = await makeCommonDir()
    await writeLooseRef(commonDir, 'refs/heads/shared', OID_B)
    // Forced worktrees can share a branch, but only the committing checkout gets a reflog append.
    const pathA = await addLinkedWorktree(commonDir, 'wt-a', 'ref: refs/heads/shared')
    const pathB = await addLinkedWorktree(commonDir, 'wt-b', 'ref: refs/heads/shared')
    const cache = createWorktreeHeadIdentityCache()
    await readIdentities(commonDir, cache)

    await writeLooseRef(commonDir, 'refs/heads/shared', OID_D)
    // Break the sibling read so its updated identity can only come from shared-ref replay.
    await rm(join(commonDir, 'worktrees', 'wt-b', 'gitdir'), { force: true })
    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))

    expect(headOf(identities, pathA)).toBe(OID_D)
    expect(headOf(identities, pathB)).toBe(OID_D)
  })

  it('re-enumerates when the scope names an entry the memoized listing lacks', async () => {
    const { commonDir, cache } = await seed()
    await writeLooseRef(commonDir, 'refs/heads/feature-c', OID_D)
    const pathC = await addLinkedWorktree(commonDir, 'wt-c', 'ref: refs/heads/feature-c')

    // A scoped entry missing from the cached listing still needs a read.
    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-c'))

    expect(headOf(identities, pathC)).toBe(OID_D)
  })

  it('propagates a primary-checkout head move to a linked worktree on the same branch', async () => {
    const commonDir = await makeCommonDir()
    const pathA = await addLinkedWorktree(commonDir, 'wt-a', 'ref: refs/heads/main')
    const cache = createWorktreeHeadIdentityCache()
    await readIdentities(commonDir, cache)

    await writeLooseRef(commonDir, 'refs/heads/main', OID_D)
    const identities = await readIdentities(commonDir, cache, PRIMARY_HEAD_IDENTITY_SCOPE)

    expect(headOf(identities, dirname(commonDir))).toBe(OID_D)
    expect(headOf(identities, pathA)).toBe(OID_D)
  })

  it('drops entries whose branch stopped resolving instead of serving a stale head', async () => {
    const commonDir = await makeCommonDir()
    await writeLooseRef(commonDir, 'refs/heads/shared', OID_B)
    const pathA = await addLinkedWorktree(commonDir, 'wt-a', 'ref: refs/heads/shared')
    const pathB = await addLinkedWorktree(commonDir, 'wt-b', 'ref: refs/heads/shared')
    const cache = createWorktreeHeadIdentityCache()
    await readIdentities(commonDir, cache)

    await rm(join(commonDir, 'refs', 'heads', 'shared'), { force: true })
    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))

    expect(headOf(identities, pathA)).toBeUndefined()
    expect(headOf(identities, pathB)).toBeUndefined()
  })

  it('does not evict a whole branch when one entry read fails transiently', async () => {
    const commonDir = await makeCommonDir()
    await writeLooseRef(commonDir, 'refs/heads/shared', OID_B)
    const pathA = await addLinkedWorktree(commonDir, 'wt-a', 'ref: refs/heads/shared')
    const pathB = await addLinkedWorktree(commonDir, 'wt-b', 'ref: refs/heads/shared')
    const cache = createWorktreeHeadIdentityCache()
    await readIdentities(commonDir, cache)

    // The shared ref itself becomes unreadable while wt-a is the scoped entry.
    await rm(join(commonDir, 'refs', 'heads', 'shared'))
    await mkdir(join(commonDir, 'refs', 'heads', 'shared'))
    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))

    expect(headOf(identities, pathA)).toBe(OID_B)
    expect(headOf(identities, pathB)).toBe(OID_B)
  })

  it('follows a relocated gitdir through the entry scope', async () => {
    const { commonDir, cache, pathA } = await seed()
    const movedPath = join(dirname(dirname(commonDir)), 'wt-a-moved')
    await writeFile(join(commonDir, 'worktrees', 'wt-a', 'gitdir'), `${join(movedPath, '.git')}\n`)

    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))

    expect(headOf(identities, movedPath)).toBe(OID_B)
    expect(headOf(identities, pathA)).toBeUndefined()
  })

  it('matches admin entry names across unicode normalization', async () => {
    const commonDir = await makeCommonDir()
    await writeLooseRef(commonDir, 'refs/heads/accent', OID_B)
    // APFS decomposed names and normalized watcher names must resolve to the same entry.
    const decomposed = 'wt-e\u0301'
    const composed = decomposed.normalize('NFC')
    expect(composed).not.toBe(decomposed)
    const path = await addLinkedWorktree(commonDir, decomposed, 'ref: refs/heads/accent')
    const cache = createWorktreeHeadIdentityCache()
    await readIdentities(commonDir, cache)

    await writeLooseRef(commonDir, 'refs/heads/accent', OID_D)
    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry(composed))

    expect(headOf(identities, path)).toBe(OID_D)
  })

  it('matches admin entry names across case folding', async () => {
    const { commonDir, cache, pathA } = await seed()
    await writeLooseRef(commonDir, 'refs/heads/feature-a', OID_D)

    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry('WT-A'))

    expect(headOf(identities, pathA)).toBe(OID_D)
  })
})
