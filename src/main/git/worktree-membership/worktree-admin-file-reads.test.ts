// The membership model and the head-identity reader share one set of admin-file rules; these
// fixtures pin that they read the same HEAD the same way.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readGitCommonHeadIdentities } from '../../ipc/worktree-head-identity-reader'
import { validateMembershipFromFiles } from './worktree-membership-file-validation'
import { WorktreeRowsNeedGit } from './worktree-membership-file-rows'

const OID_MAIN = 'a'.repeat(40)
const OID_PACKED = 'b'.repeat(40)
const OID_DETACHED = 'c'.repeat(40)
const OID_PACKED_OTHER = 'd'.repeat(40)

let root = ''
let commonDir = ''

async function writeAdminFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

async function addLinked(name: string, head: string): Promise<string> {
  const worktreePath = join(root, `wt-${name}`)
  const entry = join(commonDir, 'worktrees', name)
  await writeAdminFile(join(entry, 'HEAD'), `${head}\n`)
  await writeAdminFile(join(entry, 'gitdir'), `${worktreePath}/.git\n`)
  await writeAdminFile(join(worktreePath, '.git'), `gitdir: ${entry}\n`)
  return worktreePath
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'orca-admin-file-reads-')))
  commonDir = join(root, 'checkout', '.git')
  await writeAdminFile(join(commonDir, 'HEAD'), 'ref: refs/heads/main\n')
  await writeAdminFile(join(commonDir, 'refs', 'heads', 'main'), `${OID_MAIN}\n`)
  // A symref chain: `alias` is itself a symref to `main`.
  await writeAdminFile(join(commonDir, 'refs', 'heads', 'alias'), 'ref: refs/heads/main\n')
  await writeAdminFile(
    join(commonDir, 'packed-refs'),
    `# pack-refs with: peeled fully-peeled sorted\n${OID_PACKED} refs/heads/packed-only\n${OID_PACKED_OTHER} refs/heads/packed-other\n`
  )
})

function readRows(
  previous: Awaited<ReturnType<typeof validateMembershipFromFiles>>['state'] | null = null
) {
  return validateMembershipFromFiles({
    commonDir,
    main: { path: dirname(commonDir), isBare: false },
    previous,
    // An incremental re-derive when given a previous state, as the model runs one.
    listingOwed: previous === null,
    full: previous === null
  })
}

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('shared admin-file rules', () => {
  it('give the head-identity reader and the membership model the same heads', async () => {
    const chain = await addLinked('chain', 'ref: refs/heads/alias')
    const packed = await addLinked('packed', 'ref: refs/heads/packed-only')
    const detached = await addLinked('detached', OID_DETACHED)

    const { identities, complete } = await readGitCommonHeadIdentities(commonDir)
    const { rows } = await validateMembershipFromFiles({
      commonDir,
      main: { path: dirname(commonDir), isBare: false },
      previous: null,
      listingOwed: true,
      full: true
    })

    expect(complete).toBe(true)
    expect(identities).toHaveLength(4)
    for (const identity of identities) {
      const row = rows.find((candidate) => candidate.path === identity.worktreePath)
      expect(row, identity.worktreePath).toBeDefined()
      expect({ head: row?.head, branch: row?.branch || null }).toEqual({
        head: identity.head,
        branch: identity.branch
      })
    }
    expect(rows.map((row) => row.path)).toEqual([dirname(commonDir), chain, detached, packed])
  })

  it('reports the branch a symref chain ends at, as Git does', async () => {
    const chain = await addLinked('chain', 'ref: refs/heads/alias')

    const { identities } = await readGitCommonHeadIdentities(commonDir)

    expect(identities.find((identity) => identity.worktreePath === chain)).toEqual({
      worktreePath: chain,
      head: OID_MAIN,
      branch: 'refs/heads/main'
    })
  })

  it('stops a symref chain where Git does: the HEAD read counts toward the depth', async () => {
    // alias1 -> alias2 -> alias3 -> main; with HEAD that is Git's five reads.
    for (const [name, target] of [
      ['alias3', 'main'],
      ['alias2', 'alias3'],
      ['alias1', 'alias2'],
      ['alias0', 'alias1']
    ]) {
      await writeAdminFile(join(commonDir, 'refs', 'heads', name), `ref: refs/heads/${target}\n`)
    }
    const within = await addLinked('within', 'ref: refs/heads/alias1')
    const { rows } = await readRows()
    expect(rows.find((row) => row.path === within)?.branch).toBe('refs/heads/main')

    const beyond = await addLinked('beyond', 'ref: refs/heads/alias0')
    await expect(readRows()).rejects.toBeInstanceOf(WorktreeRowsNeedGit)
    const { identities } = await readGitCommonHeadIdentities(commonDir)
    expect(identities.find((identity) => identity.worktreePath === beyond)).toBeUndefined()
  })

  it('leaves a symlinked HEAD to Git, which reads the link as a symref', async () => {
    await addLinked('linked', 'ref: refs/heads/main')
    const head = join(commonDir, 'worktrees', 'linked', 'HEAD')
    await rm(head)
    await symlink('refs/heads/main', head)
    const rejection = await readRows().catch((error: unknown) => error)
    expect(rejection).toBeInstanceOf(WorktreeRowsNeedGit)
    expect(rejection).toMatchObject({ transient: false })
  })

  it('keeps only the packed refs rows looked up, and still resolves a new one', async () => {
    const packed = await addLinked('packed', 'ref: refs/heads/packed-only')
    const first = await readRows()
    expect([...first.state.packedRefs.keys()]).toEqual(['refs/heads/packed-only'])

    const other = await addLinked('other', 'ref: refs/heads/packed-other')
    const { rows } = await readRows(first.state)
    expect(rows.find((row) => row.path === packed)?.head).toBe(OID_PACKED)
    expect(rows.find((row) => row.path === other)?.head).toBe(OID_PACKED_OTHER)
  })
})
