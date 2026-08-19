import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BoundedFileReader from '../../shared/node-bounded-file-reader'
import {
  createBoundedFileReaderModuleMock,
  createFsPromisesModuleMock,
  createGitRunnerModuleMock
} from './status-test-harness'

const {
  gitExecFileAsyncMock,
  gitExecFileAsyncBufferMock,
  gitStreamOptionsMock,
  lstatMock,
  realpathMock,
  readFileMock,
  statMock,
  rmMock,
  existsSyncMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncBufferMock: vi.fn(),
  gitStreamOptionsMock: vi.fn(),
  lstatMock: vi.fn(),
  realpathMock: vi.fn(),
  readFileMock: vi.fn(),
  statMock: vi.fn(),
  rmMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('./runner', () =>
  createGitRunnerModuleMock({
    gitExecFileAsyncMock,
    gitExecFileAsyncBufferMock,
    gitStreamOptionsMock
  })
)

vi.mock('fs/promises', () =>
  createFsPromisesModuleMock({ lstatMock, realpathMock, readFileMock, statMock, rmMock })
)

vi.mock('fs', () => ({
  existsSync: existsSyncMock
}))

vi.mock('../../shared/node-bounded-file-reader', async (importOriginal) =>
  createBoundedFileReaderModuleMock(await importOriginal<typeof BoundedFileReader>(), {
    readFileMock,
    statMock
  })
)

import { getBranchCompare, getCommitCompare } from './status'

describe('getBranchCompare', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
    readFileMock.mockReset()
  })

  // Why dispatch on args instead of mockResolvedValueOnce chains: getBranchCompare now
  // issues its head-of-chain reads concurrently, so a positional mock would encode call
  // order rather than behaviour and break on any safe reordering.
  type BranchCompareGitResponses = {
    branch?: string | Error
    probe?: Record<string, string | Error>
    headOid?: string | Error
    baseOid?: string | Error
    mergeBase?: string | Error
    nameStatus?: string | Error
    numstat?: string | Error
    revList?: string | Error
  }

  function mockBranchCompareGit(responses: BranchCompareGitResponses): void {
    const reply = (
      value: string | Error | undefined,
      label: string
    ): Promise<{ stdout: string }> => {
      if (value === undefined) {
        throw new Error(`unexpected git call: ${label}`)
      }
      return value instanceof Error ? Promise.reject(value) : Promise.resolve({ stdout: value })
    }
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'branch') {
        return reply(responses.branch, 'branch --show-current')
      }
      if (args[0] === 'rev-parse' && args.includes('--quiet')) {
        const probed = args.find((arg) => arg.endsWith('^{commit}')) ?? ''
        return reply(responses.probe?.[probed], `probe ${probed}`)
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return reply(responses.headOid, 'rev-parse HEAD')
      }
      if (args[0] === 'rev-parse') {
        return reply(responses.baseOid, `rev-parse ${args.at(-1)}`)
      }
      if (args[0] === 'merge-base') {
        return reply(responses.mergeBase, 'merge-base')
      }
      if (args.includes('--name-status')) {
        return reply(responses.nameStatus, 'diff --name-status')
      }
      if (args.includes('--numstat')) {
        return reply(responses.numstat, 'diff --numstat')
      }
      if (args[0] === 'rev-list') {
        return reply(responses.revList, 'rev-list')
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })
  }

  it('returns a pinned branch compare snapshot and parsed branch entries', async () => {
    mockBranchCompareGit({
      branch: 'main\n',
      probe: { 'refs/remotes/origin/main^{commit}': 'base-oid\n' },
      headOid: 'head-oid\n',
      baseOid: 'base-oid\n',
      mergeBase: 'merge-base-oid\n',
      nameStatus: 'M\tfile-a.ts\nR100\told-name.ts\tnew-name.ts\nC100\told-copy.ts\tnew-copy.ts\n',
      numstat:
        '10\t2\tfile-a.ts\n1\t1\told-name.ts => new-name.ts\n3\t0\told-copy.ts => new-copy.ts\n',
      revList: '7\n'
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary).toEqual({
      baseRef: 'origin/main',
      baseOid: 'base-oid',
      compareRef: 'main',
      headOid: 'head-oid',
      mergeBase: 'merge-base-oid',
      changedFiles: 3,
      commitsAhead: 7,
      status: 'ready'
    })
    expect(result.entries).toEqual([
      { path: 'file-a.ts', status: 'modified', added: 10, removed: 2 },
      { path: 'new-name.ts', oldPath: 'old-name.ts', status: 'renamed', added: 1, removed: 1 },
      { path: 'new-copy.ts', oldPath: 'old-copy.ts', status: 'copied', added: 3, removed: 0 }
    ])
  })

  it('returns invalid-base when the compare ref does not resolve', async () => {
    mockBranchCompareGit({
      branch: 'main\n',
      probe: {
        'refs/remotes/origin/missing^{commit}': new Error('missing remote base'),
        'refs/heads/origin/missing^{commit}': new Error('missing local base')
      },
      headOid: 'head-oid\n',
      baseOid: new Error('missing base')
    })

    const result = await getBranchCompare('/repo', 'origin/missing')

    expect(result.summary.status).toBe('invalid-base')
    expect(result.summary.errorMessage).toContain('origin/missing')
    expect(result.entries).toEqual([])
  })

  it('returns unborn-head when HEAD cannot be resolved', async () => {
    mockBranchCompareGit({
      branch: 'main\n',
      // Why the probe fails here: a proven base ref would resolve, giving 'ready'.
      probe: { 'refs/remotes/origin/main^{commit}': new Error('missing base') },
      headOid: new Error('unborn'),
      baseOid: new Error('missing base')
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary.status).toBe('unborn-head')
    expect(result.summary.errorMessage).toContain('committed HEAD')
    expect(result.entries).toEqual([])
  })

  it('treats an unborn branch with a resolvable base as having no committed branch changes', async () => {
    mockBranchCompareGit({
      branch: 'feature\n',
      probe: { 'refs/remotes/origin/main^{commit}': 'base-oid\n' },
      headOid: new Error('unborn'),
      baseOid: 'base-oid\n'
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary).toEqual({
      baseRef: 'origin/main',
      baseOid: 'base-oid',
      compareRef: 'feature',
      headOid: null,
      mergeBase: null,
      changedFiles: 0,
      commitsAhead: 0,
      status: 'ready'
    })
    expect(result.entries).toEqual([])
  })

  it('returns no-merge-base when histories do not intersect', async () => {
    mockBranchCompareGit({
      branch: 'main\n',
      probe: { 'refs/remotes/origin/main^{commit}': 'base-oid\n' },
      headOid: 'head-oid\n',
      baseOid: 'base-oid\n',
      mergeBase: new Error('no merge base')
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary.status).toBe('no-merge-base')
    expect(result.summary.errorMessage).toContain('merge base')
    expect(result.entries).toEqual([])
  })

  it('passes core.quotePath=false to diff --name-status and parses UTF-8 paths', async () => {
    mockBranchCompareGit({
      branch: 'main\n',
      probe: { 'refs/remotes/origin/main^{commit}': 'base-oid\n' },
      headOid: 'head-oid\n',
      baseOid: 'base-oid\n',
      mergeBase: 'merge-base-oid\n',
      nameStatus: 'M\tdocs/日本語/sample.md\n',
      numstat: '2\t1\tdocs/日本語/sample.md\n',
      revList: '1\n'
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--name-status',
        '-M',
        '-C',
        'merge-base-oid',
        'head-oid'
      ],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(result.entries).toEqual([
      { path: 'docs/日本語/sample.md', status: 'modified', added: 2, removed: 1 }
    ])
  })

  // Why: the base oid now comes from the probe, so the probe must never report a ref it
  // did not actually resolve -- an empty rev-parse --quiet stdout means "not found".
  it('treats an empty probe result as an unresolved base ref', async () => {
    mockBranchCompareGit({
      branch: 'main\n',
      probe: {
        'refs/remotes/origin/main^{commit}': '\n',
        'refs/heads/origin/main^{commit}': '\n'
      },
      headOid: 'head-oid\n',
      baseOid: new Error('missing base')
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary.status).toBe('invalid-base')
  })

  // Why: the probe tries refs/remotes first, then refs/heads. Reusing "the last probed
  // oid" rather than the oid for the ref that won would return the wrong commit.
  it('reuses only the oid of the ref the probe actually resolved', async () => {
    mockBranchCompareGit({
      branch: 'feature\n',
      probe: {
        'refs/remotes/origin/main^{commit}': new Error('no remote-tracking ref'),
        'refs/heads/origin/main^{commit}': 'local-branch-oid\n'
      },
      headOid: 'head-oid\n',
      mergeBase: 'merge-base-oid\n',
      nameStatus: '',
      numstat: '',
      revList: '0\n'
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary).toMatchObject({
      baseOid: 'local-branch-oid',
      status: 'ready'
    })
  })

  // Why: an already-qualified base ref skips the probe entirely, so its oid must still
  // come from rev-parse rather than from a stale or absent probe entry.
  it('resolves an already-qualified base ref without a probe', async () => {
    mockBranchCompareGit({
      branch: 'main\n',
      headOid: 'head-oid\n',
      baseOid: 'qualified-base-oid\n',
      mergeBase: 'merge-base-oid\n',
      nameStatus: '',
      numstat: '',
      revList: '0\n'
    })

    const result = await getBranchCompare('/repo', 'refs/remotes/origin/main')

    expect(result.summary).toMatchObject({
      baseOid: 'qualified-base-oid',
      status: 'ready'
    })
  })

  it('resolves remote-tracking refs separately after probing their commit target', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'branch') {
        return Promise.resolve({ stdout: 'feature\n' })
      }
      if (
        args[0] === 'rev-parse' &&
        args.includes('--quiet') &&
        args.includes('refs/remotes/origin/main^{commit}')
      ) {
        return Promise.resolve({ stdout: 'peeled-base-oid\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return Promise.resolve({ stdout: 'head-oid\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) {
        return Promise.resolve({ stdout: 'raw-base-oid\n' })
      }
      if (args[0] === 'merge-base') {
        return Promise.resolve({ stdout: 'merge-base-oid\n' })
      }
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: '' })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({ stdout: '' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(result.summary).toMatchObject({
      baseRef: 'origin/main',
      baseOid: 'raw-base-oid',
      status: 'ready'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}'],
      { cwd: '/repo' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--end-of-options', 'refs/remotes/origin/main'],
      { cwd: '/repo' }
    )
  })

  it('attaches counts for branch compare paths containing rename markers', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'branch') {
        return Promise.resolve({ stdout: 'main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return Promise.resolve({ stdout: 'head-oid\n' })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'base-oid\n' })
      }
      if (args[0] === 'merge-base') {
        return Promise.resolve({ stdout: 'merge-base-oid\n' })
      }
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: 'M\tdocs/a => b.txt\n' })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({
          stdout: args.includes('-z') ? '1\t0\tdocs/a => b.txt\0' : '1\t0\tdocs/a => b.txt\n'
        })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '1\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getBranchCompare('/repo', 'origin/main')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '-z',
        '--numstat',
        '-M',
        '-C',
        'merge-base-oid',
        'head-oid'
      ],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(result.entries).toEqual([
      { path: 'docs/a => b.txt', status: 'modified', added: 1, removed: 0 }
    ])
  })
})

describe('getCommitCompare', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncBufferMock.mockReset()
  })

  it('attaches counts for commit compare paths containing rename markers', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'commit-oid\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: 'commit-oid parent-oid\n' })
      }
      if (args.includes('--name-status')) {
        return Promise.resolve({ stdout: 'M\tdocs/a => b.txt\n' })
      }
      if (args.includes('--numstat')) {
        return Promise.resolve({
          stdout: args.includes('-z') ? '1\t0\tdocs/a => b.txt\0' : '1\t0\tdocs/a => b.txt\n'
        })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getCommitCompare('/repo', 'commit-oid')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '-z',
        '--numstat',
        '-M',
        '-C',
        'parent-oid',
        'commit-oid'
      ],
      expect.objectContaining({ cwd: '/repo' })
    )
    expect(result.entries).toEqual([
      { path: 'docs/a => b.txt', status: 'modified', added: 1, removed: 0 }
    ])
  })
})
