import { afterEach, expect, it, vi } from 'vitest'
import type { BranchSnapshotIdentity } from './branch-ref-snapshot-identity'
import type { BranchRefSnapshot } from './branch-ref-snapshot-read'
import type { BranchRef } from './branch-ref-snapshot-data'
import type * as SnapshotReader from './branch-ref-snapshot-read'

const mocks = vi.hoisted(() => ({ read: vi.fn(), identity: vi.fn() }))
vi.mock('./branch-ref-snapshot-read', async (original) => ({
  ...(await original<typeof SnapshotReader>()),
  readBranchRefSnapshot: mocks.read,
  readBranchRemoteNames: async () => []
}))
vi.mock('./branch-ref-snapshot-identity', () => ({ resolveBranchSnapshotIdentity: mocks.identity }))
import { BranchRefSnapshotStore } from './branch-ref-snapshot-store'
import { searchBaseRefDetails } from '../resolution/repo-base-ref-search'
import { _resetBranchRefSnapshotsForTests } from './branch-ref-snapshot'
import { trackGitRefMutation } from '../../command-runner/git-ref-mutation-state'
import { publishGitRefChange, subscribeGitRefChanges } from '../git-ref-change-signal'

const identity: BranchSnapshotIdentity = {
  key: 'host\0/repo/.git',
  commonDir: '/repo/.git',
  gitDir: '/repo/.git',
  checkoutKey: '/repo/.git',
  cwd: '/repo',
  git: {}
}
const stores: BranchRefSnapshotStore[] = []
function store() {
  const result = new BranchRefSnapshotStore({
    subscribe: subscribeGitRefChanges
  })
  stores.push(result)
  mocks.identity.mockResolvedValue(identity)
  return result
}
function snapshot(name: string): { snapshot: BranchRefSnapshot; oversized: boolean } {
  const ref: BranchRef = {
    refName: `refs/heads/${name}`,
    label: name,
    searchName: name.toLowerCase(),
    oid: 'a'.repeat(40),
    committedAt: 0,
    symref: ''
  }
  return { snapshot: { refs: [ref] }, oversized: false }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
afterEach(() => {
  for (const value of stores.splice(0)) {
    value.reset()
  }
  _resetBranchRefSnapshotsForTests()
  vi.restoreAllMocks()
  mocks.read.mockReset()
  mocks.identity.mockReset()
})

it('does not publish a capture that finishes after a ref change', async () => {
  const value = store()
  const started = deferred<void>()
  const old = deferred<ReturnType<typeof snapshot>>()
  mocks.read.mockImplementationOnce(() => {
    started.resolve()
    return old.promise
  })
  mocks.read.mockResolvedValue(snapshot('new'))
  const result = value.search(identity, '', 20, true)
  await started.promise
  publishGitRefChange(identity.commonDir)
  old.resolve(snapshot('old'))
  expect(await result).toEqual([{ refName: 'refs/heads/old', localBranchName: 'old' }])
  expect(await value.search(identity, 'OLD', 20, true)).toEqual([])
})

it('serves a post-fence caller from the next physical read without making the earlier caller retry', async () => {
  const value = store()
  const started = deferred<void>()
  const old = deferred<ReturnType<typeof snapshot>>()
  mocks.read.mockImplementationOnce(() => {
    started.resolve()
    return old.promise
  })
  mocks.read.mockImplementationOnce(() => {
    // Another event during the successor read must not prevent its response from settling.
    publishGitRefChange(identity.commonDir)
    return Promise.resolve(snapshot('fresh'))
  })
  const before = value.search(identity, '', 20, true)
  await started.promise
  publishGitRefChange(identity.commonDir)
  const after = value.search(identity, '', 20, true)
  old.resolve(snapshot('old'))
  expect(await before).toEqual([{ refName: 'refs/heads/old', localBranchName: 'old' }])
  expect(await after).toEqual([{ refName: 'refs/heads/fresh', localBranchName: 'fresh' }])
})

it('starts the new generation after an obsolete physical read fails', async () => {
  const value = store()
  const started = deferred<void>()
  const old = deferred<ReturnType<typeof snapshot>>()
  mocks.read.mockImplementationOnce(() => {
    started.resolve()
    return old.promise
  })
  mocks.read.mockResolvedValue(snapshot('fresh'))
  const before = expect(value.search(identity, '', 20, true)).rejects.toThrow('obsolete failure')
  await started.promise
  publishGitRefChange(identity.commonDir)
  const after = value.search(identity, '', 20, true)
  await new Promise<void>(setImmediate)
  old.reject(new Error('obsolete failure'))
  await before
  expect(await after).toEqual([{ refName: 'refs/heads/fresh', localBranchName: 'fresh' }])
})

it('settles public searches across repeated ref publications without restarting the request', async () => {
  mocks.identity.mockResolvedValue(identity)
  const started = deferred<void>()
  const old = deferred<ReturnType<typeof snapshot>>()
  mocks.read.mockImplementationOnce(() => {
    started.resolve()
    return old.promise
  })
  mocks.read.mockImplementation(async () => {
    publishGitRefChange(identity.commonDir)
    return snapshot('successor')
  })
  const before = searchBaseRefDetails(identity.cwd, '', 20)
  await started.promise
  publishGitRefChange(identity.commonDir)
  const after = searchBaseRefDetails(identity.cwd, '', 20)
  await new Promise<void>(setImmediate)
  old.resolve(snapshot('overlapping'))
  expect(await before).toEqual([
    { refName: 'refs/heads/overlapping', localBranchName: 'overlapping' }
  ])
  expect(await after).toEqual([{ refName: 'refs/heads/successor', localBranchName: 'successor' }])
})

it('returns the initiating local-list output when the capture cannot be retained', async () => {
  const value = store()
  mocks.read.mockImplementationOnce(async (_cwd, _git, onRef) => {
    for (const ref of snapshot('local').snapshot.refs) {
      onRef(ref)
    }
    return { snapshot: null, oversized: true }
  })
  expect((await value.localRefs(identity)).map((ref) => ref.refName)).toEqual(['refs/heads/local'])
})

it('bounds concurrent capture retention and admits a temporarily pressured repository again', async () => {
  const value = store()
  const other = {
    ...identity,
    key: 'host\0/other/.git',
    cwd: '/other',
    commonDir: '/other/.git',
    checkoutKey: '/other/.git'
  }
  mocks.identity.mockImplementation(async (cwd) => (cwd === '/other' ? other : identity))
  const started = deferred<void>()
  const held = deferred<void>()
  mocks.read.mockImplementationOnce(async (_cwd, _git, _onRef, _max, lease) => {
    expect(lease.reserve(40 * 1024 * 1024)).toBe(true)
    started.resolve()
    await held.promise
    return snapshot('first')
  })
  mocks.read.mockImplementationOnce(async (_cwd, _git, onRef, _max, lease) => {
    expect(lease.reserve(40 * 1024 * 1024)).toBe(false)
    onRef(snapshot('pressured').snapshot.refs[0])
    return { snapshot: null, oversized: false }
  })
  const first = value.search(identity, '', 20, true)
  await started.promise
  expect(await value.search(other, '', 20, true)).toEqual([
    { refName: 'refs/heads/pressured', localBranchName: 'pressured' }
  ])
  held.resolve()
  await first
  mocks.read.mockImplementationOnce(async (_cwd, _git, _onRef, _max, lease) => {
    expect(lease.reserve(40 * 1024 * 1024)).toBe(true)
    return snapshot('retained')
  })
  expect(await value.search(other, '', 20, true)).toEqual([
    { refName: 'refs/heads/retained', localBranchName: 'retained' }
  ])
  mocks.read.mockRejectedValue(new Error('a retained repeat must not reread'))
  expect(await value.search(other, '', 20, true)).toEqual([
    { refName: 'refs/heads/retained', localBranchName: 'retained' }
  ])
})

it('shares a fill while independently projecting each caller query', async () => {
  const value = store()
  const started = deferred<void>()
  const fill = deferred<ReturnType<typeof snapshot>>()
  mocks.read.mockImplementation(() => {
    started.resolve()
    return fill.promise
  })
  const matching = value.search(identity, 'TOPIC', 20, true)
  const absent = value.search(identity, 'unmatched', 20, true)
  await started.promise
  fill.resolve(snapshot('topic'))
  expect(await matching).toEqual([{ refName: 'refs/heads/topic', localBranchName: 'topic' }])
  expect(await absent).toEqual([])
})

it('retries failed fills and refreshes an expired snapshot', async () => {
  const value = store()
  mocks.read.mockRejectedValueOnce(new Error('temporary read error'))
  await expect(value.search(identity, '', 20, true)).rejects.toThrow('temporary read error')
  mocks.read.mockResolvedValue(snapshot('first'))
  expect(await value.search(identity, '', 20, true)).toEqual([
    { refName: 'refs/heads/first', localBranchName: 'first' }
  ])
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 120_001)
  mocks.read.mockResolvedValue(snapshot('second'))
  expect(await value.search(identity, '', 20, true)).toEqual([
    { refName: 'refs/heads/second', localBranchName: 'second' }
  ])
})

it('does not resurrect a retired fill after a store reset', async () => {
  const value = store()
  const started = deferred<void>()
  const old = deferred<ReturnType<typeof snapshot>>()
  mocks.read.mockImplementationOnce(() => {
    started.resolve()
    return old.promise
  })
  mocks.read.mockResolvedValue(snapshot('fresh'))
  const result = value.search(identity, '', 20, true)
  await started.promise
  value.reset()
  old.resolve(snapshot('retired'))
  expect(await result).toEqual([{ refName: 'refs/heads/retired', localBranchName: 'retired' }])
  expect(await value.search(identity, '', 20, true)).toEqual([
    { refName: 'refs/heads/fresh', localBranchName: 'fresh' }
  ])
})

it('keeps demanded captures warm during a mutation and invalidates late owners only on termination', async () => {
  const other = { ...identity, key: 'host\0/late/.git', commonDir: '/late/.git', cwd: '/late' }
  mocks.identity.mockImplementation(async (cwd: string) => (cwd === '/late' ? other : identity))
  mocks.read.mockResolvedValue(snapshot('topic'))
  await searchBaseRefDetails(identity.cwd, 'topic', 20)
  expect(mocks.read).toHaveBeenCalledTimes(1)
  const end = trackGitRefMutation(['commit'])
  expect(mocks.read).toHaveBeenCalledTimes(1)
  await searchBaseRefDetails(identity.cwd, 'TOPIC', 20)
  await searchBaseRefDetails(identity.cwd, 'absent', 20)
  await searchBaseRefDetails(other.cwd, 'topic', 20)
  await searchBaseRefDetails(other.cwd, 'absent', 20)
  expect(mocks.read).toHaveBeenCalledTimes(3)
  end()
  expect(mocks.read).toHaveBeenCalledTimes(3)
  await searchBaseRefDetails(identity.cwd, 'topic', 20)
  await searchBaseRefDetails(other.cwd, 'topic', 20)
  expect(mocks.read).toHaveBeenCalledTimes(5)
})
