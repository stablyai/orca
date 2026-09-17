import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import {
  checkPinAncestry,
  corpusProvenanceChanged,
  removeScratchWorktree,
  repinInstruction
} from './rpc-recording-pin-guard.mts'

const scratch: string[] = []
async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr}`)
  }
  return result.stdout.trim()
}
/** A repository of our own, so no verdict in this file can depend on — or touch — the real refs. */
async function throwawayRepository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'pin-guard-'))
  scratch.push(directory)
  const repository = join(directory, 'repo')
  await git(directory, 'init', '--quiet', '--initial-branch=main', 'repo')
  await git(repository, 'config', 'user.email', 'pin-guard@example.invalid')
  await git(repository, 'config', 'user.name', 'Pin Guard')
  return repository
}
async function commit(repository: string, body: string): Promise<string> {
  await writeFile(join(repository, 'product.ts'), `${body}\n`)
  await git(repository, 'add', 'product.ts')
  await git(repository, 'commit', '--quiet', '--no-verify', '--message', body)
  return await git(repository, 'rev-parse', 'HEAD')
}
async function commitAt(repository: string, path: string, body: string): Promise<string> {
  await mkdir(dirname(join(repository, path)), { recursive: true })
  await writeFile(join(repository, path), `${body}\n`)
  await git(repository, 'add', path)
  await git(repository, 'commit', '--quiet', '--no-verify', '--message', path)
  return await git(repository, 'rev-parse', 'HEAD')
}
const RECORDER_FILE = 'mobile/src/test-support/rpc-recording/run-recording.ts'
/** Both provenance paths: the gate refuses to answer when either one names nothing. */
async function seedProvenance(repository: string): Promise<string> {
  await commitAt(repository, 'mobile/rpc-foundation/pilot-scenarios.json', 'pin')
  return await commitAt(repository, RECORDER_FILE, 'recorder')
}
const MISSING_SHA = '0123456789abcdef0123456789abcdef01234567'

// File scope, not per-suite: a suite-local hook fires before the later suites have made theirs.
afterAll(async () => {
  for (const directory of scratch) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('recording pin ancestry', () => {
  it('passes when the pin is the commit itself', async () => {
    const repository = await throwawayRepository()
    const first = await commit(repository, 'one')
    expect(await checkPinAncestry(repository, first, first)).toMatchObject({ ok: true })
  })

  it('passes on ordinary drift: the tree has moved on, the pin is still reachable', async () => {
    const repository = await throwawayRepository()
    const pin = await commit(repository, 'one')
    const head = await commit(repository, 'two')
    expect(await checkPinAncestry(repository, pin, head)).toMatchObject({ ok: true })
  })

  it('passes on a branch that pinned its own commit, judged against that branch', async () => {
    const repository = await throwawayRepository()
    await commit(repository, 'one')
    await git(repository, 'switch', '--quiet', '--create', 'behaviour-change')
    const branchPin = await commit(repository, 'two')
    const branchHead = await commit(repository, 'three')
    expect(await checkPinAncestry(repository, branchPin, branchHead)).toMatchObject({ ok: true })
  })

  it('passes a branch cut before main repinned, judged against the merge preview', async () => {
    const repository = await throwawayRepository()
    const branchPoint = await commitAt(repository, 'mobile/src/session/route.ts', 'base')
    const mainPin = await commitAt(
      repository,
      'mobile/rpc-foundation/pilot-scenarios.json',
      'repin'
    )
    await git(repository, 'switch', '--quiet', '--create', 'refactor', branchPoint)
    const branchHead = await commitAt(repository, 'mobile/src/session/route.ts', 'migrated')
    await git(repository, 'merge', '--quiet', '--no-edit', 'main')
    const preview = await git(repository, 'rev-parse', 'HEAD')
    // The preview is the tree CI checks out and reads the pin from, so it is the tree to judge.
    expect(await checkPinAncestry(repository, mainPin, preview)).toMatchObject({ ok: true })
    // The head sha would have failed this ordinary branch, and told the author to repin to it.
    expect(await checkPinAncestry(repository, mainPin, branchHead)).toMatchObject({
      ok: false,
      failure: 'not-an-ancestor'
    })
  })

  it('fails once that branch squash-merges and the pin leaves the history', async () => {
    const repository = await throwawayRepository()
    const base = await commit(repository, 'one')
    await git(repository, 'switch', '--quiet', '--create', 'behaviour-change')
    const branchPin = await commit(repository, 'two')
    await git(repository, 'switch', '--quiet', 'main')
    await git(repository, 'reset', '--quiet', '--hard', base)
    const squashed = await commit(repository, 'two, squashed')
    const verdict = await checkPinAncestry(repository, branchPin, squashed)
    expect(verdict).toMatchObject({ ok: false, failure: 'not-an-ancestor' })
    expect(verdict.ok).toBe(false)
    if (verdict.ok) {
      return
    }
    expect(verdict.message).toContain(branchPin)
    expect(verdict.message).toContain('scripts/rpc-recording.mts --record')
    expect(verdict.message).toContain('mobile/rpc-foundation/pilot-scenarios.json')
  })

  it('fails with the same instruction when the pin is no commit at all', async () => {
    const repository = await throwawayRepository()
    const head = await commit(repository, 'one')
    const verdict = await checkPinAncestry(repository, MISSING_SHA, head)
    expect(verdict).toMatchObject({ ok: false, failure: 'unreachable' })
    expect(verdict.ok ? '' : verdict.message).toContain('scripts/rpc-recording.mts --record')
  })

  it('refuses to answer on a shallow clone instead of trusting grafted history', async () => {
    const repository = await throwawayRepository()
    const pin = await commit(repository, 'one')
    await commit(repository, 'two')
    const head = await commit(repository, 'three')
    const clone = join(repository, '..', 'shallow')
    await git(repository, 'clone', '--quiet', '--depth', '1', `file://${repository}`, clone)
    // The pin is real and reachable in the full repository; only the missing history hides it.
    expect(await checkPinAncestry(repository, pin, head)).toMatchObject({ ok: true })
    const verdict = await checkPinAncestry(clone, pin, 'HEAD')
    expect(verdict).toMatchObject({ ok: false, failure: 'shallow' })
    expect(verdict.ok ? '' : verdict.message).toContain('fetch-depth: 0')
  })

  it('names the head and the pin in the instruction', () => {
    expect(
      repinInstruction('a'.repeat(40), 'b'.repeat(40), 'is not an ancestor of this commit')
    ).toContain(`git switch -c repin-rpc-recording ${'b'.repeat(40)}`)
  })
})

describe('what a reproduction reads from the candidate tree', () => {
  it('skips the run when only product sources moved', async () => {
    const repository = await throwawayRepository()
    await seedProvenance(repository)
    const base = await commitAt(repository, 'mobile/src/session/route.ts', 'before')
    await commitAt(repository, 'mobile/src/session/route.ts', 'after')
    expect(await corpusProvenanceChanged(repository, base)).toBe(false)
  })

  it('runs when a golden moved', async () => {
    const repository = await throwawayRepository()
    await seedProvenance(repository)
    const base = await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{}')
    await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{"spliced": true}')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('runs when the pin itself moved', async () => {
    const repository = await throwawayRepository()
    await seedProvenance(repository)
    const base = await commitAt(repository, 'mobile/rpc-foundation/pilot-scenarios.json', 'one')
    await commitAt(repository, 'mobile/rpc-foundation/pilot-scenarios.json', 'two')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('ignores a corpus change the base branch made without this branch', async () => {
    const repository = await throwawayRepository()
    await seedProvenance(repository)
    const branchPoint = await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{}')
    await commitAt(repository, 'mobile/rpc-foundation/goldens/b.json', '{}')
    const baseTip = await git(repository, 'rev-parse', 'HEAD')
    await git(repository, 'switch', '--quiet', '--create', 'refactor', branchPoint)
    await commitAt(repository, 'mobile/src/session/route.ts', 'migrated')
    expect(await corpusProvenanceChanged(repository, baseTip)).toBe(false)
  })

  it('runs when the recorder moved, because every golden pins it by digest', async () => {
    const repository = await throwawayRepository()
    const base = await seedProvenance(repository)
    await commitAt(repository, RECORDER_FILE, 'two')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('refuses to answer when a provenance path names nothing, instead of skipping forever', async () => {
    const repository = await throwawayRepository()
    const base = await seedProvenance(repository)
    await git(repository, 'mv', 'mobile/rpc-foundation', 'mobile/rpc-corpus')
    await git(repository, 'commit', '--quiet', '--no-verify', '--message', 'rename the corpus')
    await expect(corpusProvenanceChanged(repository, base)).rejects.toThrow('not a tracked path')
  })
})

describe('scratch worktree teardown', () => {
  it('leaves an unrelated worktree registered when its directory is missing', async () => {
    const repository = await throwawayRepository()
    await commit(repository, 'one')
    const trees = join(repository, '..', 'trees')
    for (const name of ['scratch', 'kept', 'unmounted']) {
      await git(repository, 'worktree', 'add', '--quiet', '--detach', join(trees, name))
    }
    // Stands in for a worktree on an unmounted volume: `git worktree prune` would deregister it.
    await rm(join(trees, 'unmounted'), { recursive: true, force: true })
    await removeScratchWorktree(repository, join(trees, 'scratch'))
    const registered = await git(repository, 'worktree', 'list', '--porcelain')
    expect(registered).toContain('trees/kept')
    expect(registered).toContain('trees/unmounted')
    expect(registered).not.toContain('trees/scratch')
  })
})
