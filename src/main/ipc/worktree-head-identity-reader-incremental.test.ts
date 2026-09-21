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
    // Cold start: no cache and no scope, so every entry is read.
    const identities = await readIdentities(commonDir, cache)
    expect(identities).toHaveLength(3)
    expect(headOf(identities, pathA)).toBe(OID_B)
    expect(headOf(identities, pathB)).toBe(OID_C)
    return { commonDir, cache, pathA, pathB }
  }

  it('reads every entry on cold start with an empty cache', async () => {
    const { cache } = await seed()
    expect([...cache.entries.keys()].sort()).toEqual(['wt-a', 'wt-b'])
    expect(cache.primary?.head).toBe(OID_A)
  })

  it('re-reads only the committing worktree and leaves the rest cached', async () => {
    const { commonDir, cache, pathA, pathB } = await seed()

    // A commit in wt-a moves its branch; wt-b's branch also moves on disk but
    // no watcher event named it, so the incremental read must not observe it.
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
    // The other entries move on disk with no event of their own and must stay cached.
    await writeLooseRef(commonDir, 'refs/heads/feature-a', OID_D)

    const identities = await readIdentities(commonDir, cache, LISTING_HEAD_IDENTITY_SCOPE)

    expect(headOf(identities, pathC)).toBe(OID_D)
    expect(headOf(identities, pathA)).toBe(OID_B)
  })

  it('drops an externally removed worktree through the listing scope', async () => {
    const { commonDir, cache, pathA, pathB } = await seed()
    await rm(join(commonDir, 'worktrees', 'wt-b'), { recursive: true, force: true })

    const identities = await readIdentities(commonDir, cache, LISTING_HEAD_IDENTITY_SCOPE)

    expect(identities.map((identity) => identity.worktreePath)).toEqual([dirname(commonDir), pathA])
    expect(headOf(identities, pathB)).toBeUndefined()
    expect(cache.entries.has('wt-b')).toBe(false)
  })

  it('re-reads an admin entry whose name was removed and immediately reused', async () => {
    const { commonDir, cache, pathA } = await seed()
    // One debounce window can coalesce `git worktree remove` + `git worktree
    // add` onto the same admin dir name, so the listing alone is not enough.
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

  it('keeps the memo when the worktrees listing fails for anything but absence', async () => {
    const { commonDir, cache, pathA, pathB } = await seed()
    // Stand in for EIO/ESTALE/EMFILE: readdir rejects with ENOTDIR, which is
    // not evidence that every worktree was removed.
    await rm(join(commonDir, 'worktrees'), { recursive: true, force: true })
    await writeFile(join(commonDir, 'worktrees'), 'not a directory\n')

    const identities = await readIdentities(commonDir, cache, LISTING_HEAD_IDENTITY_SCOPE)

    expect(headOf(identities, pathA)).toBe(OID_B)
    expect(headOf(identities, pathB)).toBe(OID_C)
    // The add/remove that triggered the burst is still unseen, so the next
    // refresh must re-enumerate whatever scope it is given.
    expect(cache.entryNames).toBeNull()

    await rm(join(commonDir, 'worktrees'), { force: true })
    await writeLooseRef(commonDir, 'refs/heads/feature-c', OID_D)
    const pathC = await addLinkedWorktree(commonDir, 'wt-c', 'ref: refs/heads/feature-c')
    const recovered = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))
    expect(headOf(recovered, pathC)).toBe(OID_D)
  })

  it('reports an absent worktrees dir as genuinely empty', async () => {
    const { commonDir, cache, pathA } = await seed()
    await rm(join(commonDir, 'worktrees'), { recursive: true, force: true })

    const identities = await readIdentities(commonDir, cache, LISTING_HEAD_IDENTITY_SCOPE)

    expect(headOf(identities, pathA)).toBeUndefined()
    expect(cache.entries.size).toBe(0)
  })

  it('needs the full scope, not a narrow one, to survive a packed-refs rewrite', async () => {
    const { commonDir, cache, pathA, pathB } = await seed()
    // A fetch repacked refs: the loose files are gone and the oids moved, with
    // no event under any admin dir.
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

    // Negative control: this is exactly why `packed-refs` must classify to the
    // full scope — any narrower scope misses the repack for unnamed entries.
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
    // Only the checkout is gone; git prunes the admin entry lazily, and the
    // structural listing — not this reader — owns the prunable verdict.
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
    // `git worktree add --force` lets two worktrees hold one branch, and only
    // the committing one gets a HEAD reflog append.
    const pathA = await addLinkedWorktree(commonDir, 'wt-a', 'ref: refs/heads/shared')
    const pathB = await addLinkedWorktree(commonDir, 'wt-b', 'ref: refs/heads/shared')
    const cache = createWorktreeHeadIdentityCache()
    await readIdentities(commonDir, cache)

    await writeLooseRef(commonDir, 'refs/heads/shared', OID_D)
    // Make wt-b unreadable: if the replay re-read it, it would resolve to
    // nothing and drop out. Surviving with the new oid proves it was replayed
    // from the memo rather than re-read.
    await rm(join(commonDir, 'worktrees', 'wt-b', 'gitdir'), { force: true })
    const identities = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))

    expect(headOf(identities, pathA)).toBe(OID_D)
    expect(headOf(identities, pathB)).toBe(OID_D)
  })

  it('re-enumerates when the scope names an entry the memoized listing lacks', async () => {
    const { commonDir, cache } = await seed()
    await writeLooseRef(commonDir, 'refs/heads/feature-c', OID_D)
    const pathC = await addLinkedWorktree(commonDir, 'wt-c', 'ref: refs/heads/feature-c')

    // An entry-only scope (`worktrees/wt-c/HEAD`) with no listing bit must not
    // resolve to zero work just because the memo predates the entry.
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

  it('keeps the last verified identity when an entry read fails transiently', async () => {
    const { commonDir, cache, pathA, pathB } = await seed()
    // EISDIR stands in for EIO/EACCES/ENFILE: the read fails for a reason that
    // is not absence, so the entry is UNKNOWN — never reported as gone.
    await rm(join(commonDir, 'worktrees', 'wt-a', 'HEAD'))
    await mkdir(join(commonDir, 'worktrees', 'wt-a', 'HEAD'))

    const scoped = await readIdentities(commonDir, cache, headIdentityScopeForEntry('wt-a'))
    expect(headOf(scoped, pathA)).toBe(OID_B)
    expect(cache.unverified.has('wt-a')).toBe(true)

    // And an unknown never evicts a sibling that merely shares the branch.
    expect(headOf(scoped, pathB)).toBe(OID_C)

    // Retried on the very next pass even though nothing names it, and the pass
    // is reported incomplete so it cannot pass for a freshness checkpoint.
    const stillBroken = await readGitCommonHeadIdentities(commonDir, cache)
    expect(stillBroken.complete).toBe(false)

    await rm(join(commonDir, 'worktrees', 'wt-a', 'HEAD'), { recursive: true })
    await writeFile(join(commonDir, 'worktrees', 'wt-a', 'HEAD'), 'ref: refs/heads/feature-a\n')
    await writeLooseRef(commonDir, 'refs/heads/feature-a', OID_D)
    const recovered = await readGitCommonHeadIdentities(
      commonDir,
      cache,
      PRIMARY_HEAD_IDENTITY_SCOPE
    )
    expect(headOf(recovered.identities, pathA)).toBe(OID_D)
    expect(recovered.complete).toBe(true)
    expect(cache.unverified.size).toBe(0)
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

    // An unknown must not be replayed onto siblings as "this branch is gone".
    expect(headOf(identities, pathA)).toBe(OID_B)
    expect(headOf(identities, pathB)).toBe(OID_B)
  })

  it('never caches a miss, so a transient unreadable entry is retried', async () => {
    const commonDir = await makeCommonDir()
    const entry = join(commonDir, 'worktrees', 'wt-a')
    await mkdir(entry, { recursive: true })
    await writeFile(join(entry, 'HEAD'), 'ref: refs/heads/feature-a\n')
    const cache = createWorktreeHeadIdentityCache()

    // No `gitdir` yet (mid `git worktree add`): unresolvable, so nothing is memoized.
    expect(await readIdentities(commonDir, cache)).toHaveLength(1)
    expect(cache.entries.has('wt-a')).toBe(false)

    await writeLooseRef(commonDir, 'refs/heads/feature-a', OID_B)
    const worktreePath = join(dirname(dirname(commonDir)), 'wt-a')
    await writeFile(join(entry, 'gitdir'), `${join(worktreePath, '.git')}\n`)

    // A later refresh that never names wt-a still recovers it.
    const identities = await readIdentities(commonDir, cache, PRIMARY_HEAD_IDENTITY_SCOPE)
    expect(headOf(identities, worktreePath)).toBe(OID_B)
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
    // Decomposed on disk (what APFS hands back for a name typed as NFD), and the
    // watcher may report either form; the fold has to bridge them.
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
