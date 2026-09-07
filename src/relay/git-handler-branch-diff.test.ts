import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayContext } from './context'
import {
  branchDiffEntryAtPinnedOids,
  isFullGitObjectId,
  parseOptionalBranchDiffHeadOid
} from './git-handler-branch-diff-ops'
import { GitHandler } from './git-handler'
import { branchDiffEntries, type GitBufferExec, type GitExec } from './git-handler-ops'
import {
  createMockDispatcher,
  gitCommit,
  gitInit,
  type MockDispatcher,
  type RelayDispatcher
} from './git-handler-test-setup'

const BASE_OID = 'a'.repeat(40)
const HEAD_OID = 'b'.repeat(40)
const OTHER_HEAD_OID = 'c'.repeat(40)
const MERGE_BASE_OID = 'd'.repeat(40)
const FILE_PATH = 'src/file.ts'

type GitBufferTarget = {
  gitBuffer(args: string[], cwd: string): Promise<Buffer>
}

type GitTarget = {
  git(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }>
}

function deferredBuffer(): { promise: Promise<Buffer>; resolve: (content: string) => void } {
  let resolve!: (value: Buffer) => void
  const promise = new Promise<Buffer>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve: (content) => resolve(Buffer.from(content)) }
}

describe('pinned relay branch diff operation', () => {
  it.each([
    {
      name: 'addition',
      status: `A\t${FILE_PATH}\n`,
      left: new Error('missing'),
      right: Buffer.from('added\n')
    },
    {
      name: 'deletion',
      status: `D\t${FILE_PATH}\n`,
      left: Buffer.from('deleted\n'),
      right: new Error('missing')
    },
    {
      name: 'binary content',
      status: `M\t${FILE_PATH}\n`,
      left: Buffer.from([0, 1]),
      right: Buffer.from([0, 2])
    },
    {
      name: 'blob read failure',
      status: `M\t${FILE_PATH}\n`,
      left: new Error('left failed'),
      right: new Error('right failed')
    }
  ])('matches the legacy $name result', async ({ status, left, right }) => {
    const createGitBuffer = (): GitBufferExec =>
      vi.fn<GitBufferExec>(async (args) => {
        const value = args[2].startsWith(`${BASE_OID}:`) ? left : right
        if (value instanceof Error) {
          throw value
        }
        return value
      })
    const git = vi.fn<GitExec>(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return { stdout: `${HEAD_OID}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse' || args[0] === 'merge-base') {
        return { stdout: `${BASE_OID}\n`, stderr: '' }
      }
      return { stdout: status, stderr: '' }
    })

    const pinned = await branchDiffEntryAtPinnedOids(
      createGitBuffer(),
      '/repo',
      BASE_OID,
      HEAD_OID,
      FILE_PATH
    )
    const legacy = await branchDiffEntries(git, createGitBuffer(), '/repo', BASE_OID, {
      includePatch: true,
      filePath: FILE_PATH
    })

    expect(pinned).toEqual(legacy)
  })

  // Why: GitBranchCompareSummary.headOid is `string | null`, so an unpinned
  // snapshot arrives as an explicit null and must stay servable.
  it.each([
    { name: 'absent', params: {} },
    { name: 'null', params: { headOid: null } },
    { name: 'undefined', params: { headOid: undefined } }
  ])('treats a $name head OID as unpinned', ({ params }) => {
    expect(parseOptionalBranchDiffHeadOid(params)).toBeUndefined()
  })

  it.each([
    { name: 'SHA-1', headOid: HEAD_OID },
    { name: 'SHA-256', headOid: 'b'.repeat(64) }
  ])('returns a supplied $name head OID', ({ headOid }) => {
    expect(parseOptionalBranchDiffHeadOid({ headOid })).toBe(headOid)
  })

  it.each([{ headOid: 'abc123' }, { headOid: '' }, { headOid: 'main' }, { headOid: 123 }])(
    'rejects the supplied malformed head OID $headOid',
    ({ headOid }) => {
      expect(() => parseOptionalBranchDiffHeadOid({ headOid })).toThrow(
        'headOid must be a full git object id'
      )
    }
  )

  it('recognizes only full object ids', () => {
    expect(isFullGitObjectId(BASE_OID)).toBe(true)
    expect(isFullGitObjectId('A'.repeat(64))).toBe(true)
    for (const value of ['origin/main', 'abc123', '', 'g'.repeat(40), null, undefined, 123, {}]) {
      expect(isFullGitObjectId(value)).toBe(false)
    }
  })

  // Why: the route guards this today, but the export is reachable on its own —
  // a symbolic ref here would resolve `git show origin/main:<path>` at live HEAD.
  it('rejects a symbolic ref at the module boundary', async () => {
    const gitBuffer = vi.fn<GitBufferExec>(async () => Buffer.from(''))
    await expect(
      branchDiffEntryAtPinnedOids(gitBuffer, '/repo', 'origin/main', HEAD_OID, FILE_PATH)
    ).rejects.toThrow('baseRef must be a full git object id')
    await expect(
      branchDiffEntryAtPinnedOids(gitBuffer, '/repo', BASE_OID, 'HEAD', FILE_PATH)
    ).rejects.toThrow('headOid must be a full git object id')
    expect(gitBuffer).not.toHaveBeenCalled()
  })
})

describe('GitHandler pinned branch diff route', () => {
  let dispatcher: MockDispatcher
  let handler: GitHandler

  beforeEach(() => {
    dispatcher = createMockDispatcher()
    handler = new GitHandler(dispatcher as unknown as RelayDispatcher, new RelayContext())
  })

  afterEach(() => {
    handler.dispose()
    vi.restoreAllMocks()
  })

  function request(overrides: Record<string, unknown> = {}): Promise<unknown> {
    return dispatcher.callRequest('git.branchDiff', {
      worktreePath: '/repo',
      baseRef: BASE_OID,
      headOid: HEAD_OID,
      includePatch: true,
      filePath: FILE_PATH,
      ...overrides
    })
  }

  function mockLegacyGit(nameStatus = '') {
    return vi.spyOn(handler as unknown as GitTarget, 'git').mockImplementation(async (args) => {
      if (args[0] === 'rev-parse' && args.includes('HEAD')) {
        return { stdout: `${HEAD_OID}\n`, stderr: '' }
      }
      if (args[0] === 'rev-parse') {
        return { stdout: `${BASE_OID}\n`, stderr: '' }
      }
      if (args[0] === 'merge-base') {
        return { stdout: `${MERGE_BASE_OID}\n`, stderr: '' }
      }
      return { stdout: nameStatus, stderr: '' }
    })
  }

  it('starts exactly two pinned blob reads concurrently without metadata commands', async () => {
    const left = deferredBuffer()
    const right = deferredBuffer()
    const gitBufferSpy = vi
      .spyOn(handler as unknown as GitBufferTarget, 'gitBuffer')
      .mockImplementation((args) => {
        if (args[2] === `${BASE_OID}:${FILE_PATH}`) {
          return left.promise
        }
        if (args[2] === `${HEAD_OID}:${FILE_PATH}`) {
          return right.promise
        }
        throw new Error(`unexpected blob spec: ${args[2]}`)
      })
    const gitSpy = vi
      .spyOn(handler as unknown as GitTarget, 'git')
      .mockRejectedValue(new Error('metadata command should not run'))

    const resultPromise = request()
    await vi.waitFor(() => expect(gitBufferSpy).toHaveBeenCalledTimes(2))

    expect(gitSpy).not.toHaveBeenCalled()
    expect(gitBufferSpy.mock.calls.map(([args]) => args)).toEqual([
      ['show', '--end-of-options', `${BASE_OID}:${FILE_PATH}`],
      ['show', '--end-of-options', `${HEAD_OID}:${FILE_PATH}`]
    ])

    left.resolve('before\n')
    right.resolve('after\n')
    await expect(resultPromise).resolves.toEqual([
      {
        kind: 'text',
        originalContent: 'before\n',
        modifiedContent: 'after\n',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    ])
  })

  it('reads the old path only from the base OID', async () => {
    const oldPath = 'src/old-file.ts'
    const gitBufferSpy = vi
      .spyOn(handler as unknown as GitBufferTarget, 'gitBuffer')
      .mockImplementation(async (args) => Buffer.from(args[2].startsWith(BASE_OID) ? 'old' : 'new'))

    await request({ oldPath })

    expect(gitBufferSpy.mock.calls.map(([args]) => args[2])).toEqual([
      `${BASE_OID}:${oldPath}`,
      `${HEAD_OID}:${FILE_PATH}`
    ])
  })

  it('coalesces the same head OID while keeping different heads independent', async () => {
    const pending = deferredBuffer()
    const gitBufferSpy = vi
      .spyOn(handler as unknown as GitBufferTarget, 'gitBuffer')
      .mockImplementation(() => pending.promise)

    const requests = [request(), request(), request({ headOid: OTHER_HEAD_OID })]
    await vi.waitFor(() => expect(gitBufferSpy).toHaveBeenCalledTimes(4))

    const specs = gitBufferSpy.mock.calls.map(([args]) => args[2])
    expect(specs.filter((spec) => spec === `${BASE_OID}:${FILE_PATH}`)).toHaveLength(2)
    expect(specs.filter((spec) => spec === `${HEAD_OID}:${FILE_PATH}`)).toHaveLength(1)
    expect(specs.filter((spec) => spec === `${OTHER_HEAD_OID}:${FILE_PATH}`)).toHaveLength(1)

    pending.resolve('content\n')
    await Promise.all(requests)
  })

  it('rejects every supplied malformed head OID before running Git', async () => {
    const gitBufferSpy = vi.spyOn(handler as unknown as GitBufferTarget, 'gitBuffer')
    const invalidHeadOids = [7, {}, '', 'a'.repeat(39), 'g'.repeat(40)]

    for (const headOid of invalidHeadOids) {
      await expect(request({ headOid })).rejects.toThrow('headOid must be a full git object id')
    }

    expect(gitBufferSpy).not.toHaveBeenCalled()
  })

  it('accepts SHA-256 object IDs', async () => {
    const baseOid = 'A'.repeat(64)
    const headOid = 'b'.repeat(64)
    const gitBufferSpy = vi
      .spyOn(handler as unknown as GitBufferTarget, 'gitBuffer')
      .mockResolvedValue(Buffer.from('content\n'))

    await request({ baseRef: baseOid, headOid })

    expect(gitBufferSpy.mock.calls.map(([args]) => args[2])).toEqual([
      `${baseOid}:${FILE_PATH}`,
      `${headOid}:${FILE_PATH}`
    ])
  })

  // Why: a symbolic base ref used to select the pinned route and then throw.
  it('selects the pinned route only when the base ref is a full object id', async () => {
    const gitSpy = mockLegacyGit(`M\t${FILE_PATH}\n`)
    const gitBufferSpy = vi
      .spyOn(handler as unknown as GitBufferTarget, 'gitBuffer')
      .mockResolvedValue(Buffer.from('content\n'))

    await expect(request({ baseRef: 'origin/main' })).resolves.toHaveLength(1)

    expect(gitSpy.mock.calls.map(([args]) => args.join(' '))).toEqual([
      'rev-parse --verify HEAD',
      'rev-parse --verify origin/main',
      `merge-base ${BASE_OID} ${HEAD_OID}`,
      `-c core.quotePath=false diff --name-status -M -C ${MERGE_BASE_OID} ${HEAD_OID}`
    ])
    expect(gitBufferSpy.mock.calls.map(([args]) => args[2])).toEqual([
      `${MERGE_BASE_OID}:${FILE_PATH}`,
      `${HEAD_OID}:${FILE_PATH}`
    ])

    gitSpy.mockClear()
    gitBufferSpy.mockClear()
    await request()

    expect(gitSpy).not.toHaveBeenCalled()
    expect(gitBufferSpy.mock.calls.map(([args]) => args[2])).toEqual([
      `${BASE_OID}:${FILE_PATH}`,
      `${HEAD_OID}:${FILE_PATH}`
    ])
  })

  it('serves an explicitly null head OID through the legacy path', async () => {
    const gitSpy = mockLegacyGit(`M\t${FILE_PATH}\n`)
    const gitBufferSpy = vi.spyOn(handler as unknown as GitBufferTarget, 'gitBuffer')

    await expect(request({ headOid: null, includePatch: false })).resolves.toEqual([
      {
        kind: 'text',
        originalContent: '',
        modifiedContent: '',
        originalIsBinary: false,
        modifiedIsBinary: false
      }
    ])

    expect(gitSpy).toHaveBeenCalledTimes(4)
    expect(gitBufferSpy).not.toHaveBeenCalled()
  })

  it('uses the legacy path when patch or file-path conditions are not met', async () => {
    const gitSpy = mockLegacyGit()
    const gitBufferSpy = vi.spyOn(handler as unknown as GitBufferTarget, 'gitBuffer')

    await Promise.all([
      request({ baseRef: 'main', includePatch: false }),
      request({ baseRef: 'main', filePath: '' }),
      request({ baseRef: 'main', filePath: { malformed: true } })
    ])

    expect(gitSpy).toHaveBeenCalledTimes(12)
    expect(gitBufferSpy).not.toHaveBeenCalled()
  })

  it('keeps the requested head pinned after repository HEAD moves', async () => {
    const repoPath = mkdtempSync(path.join(tmpdir(), 'relay-pinned-branch-diff-'))
    try {
      gitInit(repoPath)
      writeFileSync(path.join(repoPath, 'file.txt'), 'base\n')
      gitCommit(repoPath, 'base')
      const baseOid = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8'
      }).trim()

      writeFileSync(path.join(repoPath, 'file.txt'), 'pinned\n')
      gitCommit(repoPath, 'pinned')
      const pinnedHeadOid = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoPath,
        encoding: 'utf8'
      }).trim()

      writeFileSync(path.join(repoPath, 'file.txt'), 'moved\n')
      gitCommit(repoPath, 'moved')

      const result = (await request({
        worktreePath: repoPath,
        baseRef: baseOid,
        headOid: pinnedHeadOid,
        filePath: 'file.txt'
      })) as { originalContent: string; modifiedContent: string }[]

      expect(result[0]).toMatchObject({
        originalContent: 'base\n',
        modifiedContent: 'pinned\n'
      })
      expect(
        execFileSync('git', ['show', 'HEAD:file.txt'], { cwd: repoPath, encoding: 'utf8' })
      ).toBe('moved\n')
    } finally {
      rmSync(repoPath, { recursive: true, force: true })
    }
  })
})
