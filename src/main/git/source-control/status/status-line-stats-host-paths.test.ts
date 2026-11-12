// Unstaged rows keep their numstat counts even when a sibling file cannot be hashed.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn()
}))

import { attachLineStats } from './status-line-stats'
import { invalidateGitBranchLineTotalInFlight } from '../../../../shared/git/status/git-branch-line-total'

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

    expect(await attachLineStats('/repo', entries)).toBe(true)

    expect(entries[0]).toMatchObject({ added: 2, removed: 3 })
    expect(entries[2]).toMatchObject({ added: 2, removed: 3 })
    expect(entries[1].added).toBeUndefined()
    expect(diffCalls.length).toBeGreaterThan(1)
    expect(diffCalls.slice(1).every((args) => args.includes('--'))).toBe(true)
  })
})
