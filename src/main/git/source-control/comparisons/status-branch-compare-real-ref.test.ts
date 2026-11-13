import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getBranchCompare } from './branch-compare'

const tempRoots: string[] = []

function git(repo: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim()
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('getBranchCompare real refs', () => {
  it.each([false, true])(
    'excludes base-only changes after branches diverge: %s',
    async (diverged) => {
      const repo = await mkdtemp(path.join(tmpdir(), 'orca-common-ancestor-compare-'))
      tempRoots.push(repo)
      git(repo, ['init', '-q'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])
      git(repo, ['config', 'commit.gpgSign', 'false'])
      git(repo, ['commit', '--allow-empty', '-qm', 'initial'])
      const forkOid = git(repo, ['rev-parse', 'HEAD'])
      git(repo, ['branch', 'base'])
      git(repo, ['checkout', '-qb', 'feature'])
      if (diverged) {
        await writeFile(path.join(repo, 'feature.txt'), 'feature\n')
        git(repo, ['add', 'feature.txt'])
        git(repo, ['commit', '-qm', 'feature addition'])
      }
      git(repo, ['checkout', '-q', 'base'])
      await writeFile(path.join(repo, 'upstream.txt'), 'upstream\n')
      git(repo, ['add', 'upstream.txt'])
      git(repo, ['commit', '-qm', 'upstream addition'])
      git(repo, ['checkout', '-q', 'feature'])

      const result = await getBranchCompare(repo, 'base')
      expect(result.summary).toMatchObject({
        status: 'ready',
        mergeBase: forkOid,
        commitsAhead: diverged ? 1 : 0,
        commitsBehind: 1,
        changedFiles: diverged ? 1 : 0
      })
      expect(result.entries).toEqual(
        diverged ? [{ path: 'feature.txt', status: 'added', added: 1, removed: 0 }] : []
      )
    }
  )

  it('reports equal commits as empty despite staged and unstaged changes', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'orca-equal-branch-compare-'))
    tempRoots.push(repo)
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'test@example.com'])
    git(repo, ['config', 'user.name', 'Test User'])
    git(repo, ['-c', 'commit.gpgSign=false', 'commit', '--allow-empty', '-m', 'initial'])
    git(repo, ['branch', 'base'])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    const oid = git(repo, ['rev-parse', 'HEAD'])
    await writeFile(path.join(repo, 'changes.txt'), 'staged\n')
    git(repo, ['add', 'changes.txt'])
    await writeFile(path.join(repo, 'changes.txt'), 'unstaged\n')

    expect(await getBranchCompare(repo, 'base')).toEqual({
      summary: {
        baseRef: 'base',
        baseOid: oid,
        compareRef: 'feature',
        headOid: oid,
        mergeBase: oid,
        changedFiles: 0,
        commitsAhead: 0,
        commitsBehind: 0,
        status: 'ready'
      },
      entries: []
    })
  })

  describe('commit-pair cache under history rewrites', () => {
    // Fixed old mtimes put every rewrite past the racy-write margin, so only the scope can force a recount.
    const aged = new Date('2020-01-01T00:00:00Z')

    /** root <- a <- b <- tip on `feature`, with `base` at root (tip is 3 ahead). */
    async function createChainRepo(): Promise<{ repo: string; oids: Record<string, string> }> {
      // Canonical path so linked worktrees and the main checkout resolve one common dir.
      const repo = await realpath(
        await mkdtemp(path.join(tmpdir(), 'orca-branch-compare-rewrite-'))
      )
      tempRoots.push(repo)
      git(repo, ['init', '-q', '-b', 'feature'])
      git(repo, ['config', 'user.email', 'test@example.com'])
      git(repo, ['config', 'user.name', 'Test User'])
      git(repo, ['config', 'commit.gpgSign', 'false'])
      const oids: Record<string, string> = {}
      for (const name of ['root', 'a', 'b', 'tip']) {
        git(repo, ['commit', '--allow-empty', '-qm', name])
        oids[name] = git(repo, ['rev-parse', 'HEAD'])
        if (name === 'root') {
          git(repo, ['branch', 'base'])
        }
      }
      return { repo, oids }
    }

    async function ageReplaceRefs(repo: string): Promise<void> {
      const replaceDir = path.join(repo, '.git', 'refs', 'replace')
      for (const entry of await readdir(replaceDir)) {
        await utimes(path.join(replaceDir, entry), aged, aged)
      }
      await utimes(replaceDir, aged, aged)
    }

    async function commitsAhead(worktree: string): Promise<number | undefined> {
      return (await getBranchCompare(worktree, 'base')).summary.commitsAhead
    }

    it('recounts after a replace ref is added', async () => {
      const { repo, oids } = await createChainRepo()
      expect(await commitsAhead(repo)).toBe(3)

      git(repo, ['replace', '--graft', oids.tip, oids.root])
      await ageReplaceRefs(repo)

      expect(await commitsAhead(repo)).toBe(1)
    })

    it('recounts after an existing loose replace ref is edited in place', async () => {
      const { repo, oids } = await createChainRepo()
      git(repo, ['replace', '--graft', oids.tip, oids.a])
      const replaceRef = path.join(repo, '.git', 'refs', 'replace', oids.tip)
      const tipOntoA = await readFile(replaceRef, 'utf8')
      git(repo, ['replace', '--force', '--graft', oids.tip, oids.root])
      await ageReplaceRefs(repo)
      expect(await commitsAhead(repo)).toBe(1)

      await writeFile(replaceRef, tipOntoA)
      await utimes(path.dirname(replaceRef), aged, aged)

      expect(await commitsAhead(repo)).toBe(2)
    })

    it('recounts after a replace ref is packed away from refs/replace', async () => {
      const { repo, oids } = await createChainRepo()
      expect(await commitsAhead(repo)).toBe(3)

      git(repo, ['replace', '--graft', oids.tip, oids.root])
      git(repo, ['pack-refs', '--all'])
      await rm(path.join(repo, '.git', 'refs', 'replace'), { recursive: true, force: true })
      await utimes(path.join(repo, '.git', 'packed-refs'), aged, aged)

      expect(await commitsAhead(repo)).toBe(1)
    })

    it('keeps per-worktree core.useReplaceRefs answers apart', async () => {
      const { repo, oids } = await createChainRepo()
      git(repo, ['replace', '--graft', oids.tip, oids.root])
      const linked = path.join(path.dirname(repo), `${path.basename(repo)}-linked`)
      tempRoots.push(linked)
      git(repo, ['worktree', 'add', '-q', '--detach', linked, oids.tip])
      git(repo, ['config', 'extensions.worktreeConfig', 'true'])
      git(linked, ['config', '--worktree', 'core.useReplaceRefs', 'false'])
      await ageReplaceRefs(repo)

      expect(await commitsAhead(repo)).toBe(1)
      expect(await commitsAhead(linked)).toBe(3)
    })

    it('honors a custom GIT_REPLACE_REF_BASE namespace', async () => {
      const { repo, oids } = await createChainRepo()
      const previous = process.env.GIT_REPLACE_REF_BASE
      process.env.GIT_REPLACE_REF_BASE = 'refs/custom-replacements/'
      try {
        expect(await commitsAhead(repo)).toBe(3)
        git(repo, ['replace', '--graft', oids.tip, oids.root])
        expect(await commitsAhead(repo)).toBe(1)
      } finally {
        if (previous === undefined) {
          delete process.env.GIT_REPLACE_REF_BASE
        } else {
          process.env.GIT_REPLACE_REF_BASE = previous
        }
      }
    })
  })

  it('preserves the raw oid of a remote-tracking ref that stores an annotated tag', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'orca-branch-compare-ref-'))
    tempRoots.push(root)
    const source = path.join(root, 'source')
    const client = path.join(root, 'client')

    execFileSync('git', ['init', '-q', source])
    git(source, ['config', 'user.email', 'test@example.com'])
    git(source, ['config', 'user.name', 'Test User'])
    git(source, ['config', 'commit.gpgSign', 'false'])
    git(source, ['config', 'tag.gpgSign', 'false'])
    git(source, ['commit', '--allow-empty', '-m', 'initial'])
    git(source, ['tag', '-a', 'annotated', '-m', 'annotated base'])
    execFileSync('git', ['clone', '-q', source, client])
    git(client, ['fetch', source, 'refs/tags/annotated:refs/remotes/origin/tagbase'])

    expect(git(client, ['branch', '-r', '--format=%(refname:short)']).split(/\r?\n/)).toContain(
      'origin/tagbase'
    )
    const rawOid = git(client, ['rev-parse', '--verify', 'refs/remotes/origin/tagbase'])
    const peeledOid = git(client, [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/remotes/origin/tagbase^{commit}'
    ])
    expect(rawOid).not.toBe(peeledOid)

    expect((await getBranchCompare(client, 'origin/tagbase')).summary).toMatchObject({
      baseOid: rawOid,
      headOid: peeledOid,
      mergeBase: peeledOid,
      changedFiles: 0,
      commitsAhead: 0,
      commitsBehind: 0,
      status: 'ready'
    })
  })
})
