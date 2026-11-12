// Unstaged rows keep their numstat counts even when a sibling file cannot be hashed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

const { numstatCacheInputs } = vi.hoisted(() => {
  type ConfigInputs = { values: Map<string, string>; files: string[]; attributeFiles: string[] }
  type StampInputs = { value: string; newestMtimeMs: number; capturedAtMs: number }
  const state: { config: ConfigInputs | null; stamp: StampInputs | null } = {
    config: null,
    stamp: null
  }
  return { numstatCacheInputs: state }
})

vi.mock('../input-stamps/stamped-git-config', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readStampedGitConfig: async () => numstatCacheInputs.config
}))

vi.mock('../input-stamps/worktree-diff-stamp', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readWorktreePathsDiffStamp: async () => numstatCacheInputs.stamp
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn()
}))

import { attachLineStats } from './status-line-stats'
import { invalidateGitBranchLineTotalInFlight } from '../../../../shared/git/status/git-branch-line-total'
import { settledNumstatCache } from '../git-read-cache-invalidation'

describe('unstaged line stats when one file cannot be hashed', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    invalidateGitBranchLineTotalInFlight()
  })

  it('counts the readable rows and leaves only the locked file uncounted', async () => {
    const entries: GitStatusEntry[] = [
      { path: 'src/a.ts', area: 'unstaged', status: 'modified' },
      { path: 'src/locked.db', area: 'unstaged', status: 'modified' },
      { path: 'src/b.ts', area: 'unstaged', status: 'modified' }
    ]
    const diffCalls: string[][] = []
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (!args.includes('--numstat')) {
        return { stdout: '', stderr: '' }
      }
      diffCalls.push(args)
      if (!args.includes('--')) {
        throw new Error('fatal: cannot hash src/locked.db')
      }
      const paths = args.slice(args.indexOf('--') + 1)
      if (paths.includes('src/locked.db')) {
        throw new Error('error: open("src/locked.db"): Permission denied')
      }
      return { stdout: paths.map((path) => `2\t3\t${path}\0`).join(''), stderr: '' }
    })

    // The readable rows still count, but a partial pass must not seed a status snapshot.
    expect(await attachLineStats('/repo', entries)).toBe(false)

    expect(entries[0]).toMatchObject({ added: 2, removed: 3 })
    expect(entries[2]).toMatchObject({ added: 2, removed: 3 })
    expect(entries[1].added).toBeUndefined()
    expect(diffCalls.length).toBeGreaterThan(1)
    expect(diffCalls.slice(1).every((args) => args.includes('--'))).toBe(true)
  })
})

describe('numstat reuse when a path cannot be hashed', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    invalidateGitBranchLineTotalInFlight()
    settledNumstatCache.clear()
    numstatCacheInputs.config = { values: new Map(), files: [], attributeFiles: [] }
    numstatCacheInputs.stamp = {
      value: 'settled-inputs',
      newestMtimeMs: Date.now() - 10_000,
      capturedAtMs: Date.now()
    }
  })

  afterEach(() => {
    numstatCacheInputs.config = null
    numstatCacheInputs.stamp = null
  })

  it('does not cache a partial pass, so the next poll rereads the locked file', async () => {
    let locked = true
    const diffCalls: string[][] = []
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (!args.includes('--numstat')) {
        return { stdout: '', stderr: '' }
      }
      diffCalls.push(args)
      if (!args.includes('--')) {
        throw new Error('fatal: cannot hash src/locked.db')
      }
      const paths = args.slice(args.indexOf('--') + 1)
      if (locked && paths.includes('src/locked.db')) {
        throw new Error('error: open("src/locked.db"): Permission denied')
      }
      return { stdout: paths.map((path) => `2\t3\t${path}\0`).join(''), stderr: '' }
    })
    const entries: GitStatusEntry[] = [
      { path: 'src/a.ts', area: 'unstaged', status: 'modified' },
      { path: 'src/locked.db', area: 'unstaged', status: 'modified' },
      { path: 'src/b.ts', area: 'unstaged', status: 'modified' }
    ]

    // Incomplete: the readable rows are applied, but the pass is neither cached nor published.
    expect(await attachLineStats('/repo', entries)).toBe(false)
    expect(entries[1].added).toBeUndefined()

    locked = false
    expect(await attachLineStats('/repo', entries)).toBe(true)
    expect(entries[1]).toMatchObject({ added: 2, removed: 3 })
    expect(diffCalls.length).toBeGreaterThan(4)
  })

  it('reuses a complete pass without spawning another numstat', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '2\t3\tsrc/a.ts\0', stderr: '' })
    const entries: GitStatusEntry[] = [{ path: 'src/a.ts', area: 'unstaged', status: 'modified' }]

    expect(await attachLineStats('/repo', entries)).toBe(true)
    const callsAfterFirstPass = gitExecFileAsyncMock.mock.calls.length

    expect(await attachLineStats('/repo', entries)).toBe(true)
    expect(gitExecFileAsyncMock.mock.calls.length).toBe(callsAfterFirstPass)
    expect(entries[0]).toMatchObject({ added: 2, removed: 3 })
  })
})
