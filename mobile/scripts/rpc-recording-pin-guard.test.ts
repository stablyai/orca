import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import {
  checkPinAncestry,
  corpusProvenanceChanged,
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
  async function commitAt(repository: string, path: string, body: string): Promise<string> {
    await mkdir(dirname(join(repository, path)), { recursive: true })
    await writeFile(join(repository, path), `${body}\n`)
    await git(repository, 'add', path)
    await git(repository, 'commit', '--quiet', '--no-verify', '--message', path)
    return await git(repository, 'rev-parse', 'HEAD')
  }

  it('skips the run when only product sources moved', async () => {
    const repository = await throwawayRepository()
    await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{}')
    const base = await commitAt(repository, 'mobile/src/session/route.ts', 'before')
    await commitAt(repository, 'mobile/src/session/route.ts', 'after')
    expect(await corpusProvenanceChanged(repository, base)).toBe(false)
  })

  it('runs when a golden moved', async () => {
    const repository = await throwawayRepository()
    const base = await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{}')
    await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{"spliced": true}')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('runs when the pin itself moved', async () => {
    const repository = await throwawayRepository()
    const base = await commitAt(repository, 'mobile/rpc-foundation/pilot-scenarios.json', 'one')
    await commitAt(repository, 'mobile/rpc-foundation/pilot-scenarios.json', 'two')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })

  it('ignores a corpus change the base branch made without this branch', async () => {
    const repository = await throwawayRepository()
    const branchPoint = await commitAt(repository, 'mobile/rpc-foundation/goldens/a.json', '{}')
    await commitAt(repository, 'mobile/rpc-foundation/goldens/b.json', '{}')
    const baseTip = await git(repository, 'rev-parse', 'HEAD')
    await git(repository, 'switch', '--quiet', '--create', 'refactor', branchPoint)
    await commitAt(repository, 'mobile/src/session/route.ts', 'migrated')
    expect(await corpusProvenanceChanged(repository, baseTip)).toBe(false)
  })

  it('runs when the recorder moved, because every golden pins it by digest', async () => {
    const repository = await throwawayRepository()
    const recorder = 'mobile/src/test-support/rpc-recording/run-recording.ts'
    const base = await commitAt(repository, recorder, 'one')
    await commitAt(repository, recorder, 'two')
    expect(await corpusProvenanceChanged(repository, base)).toBe(true)
  })
})
