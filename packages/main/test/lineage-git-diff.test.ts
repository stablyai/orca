import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import { getLineageFileDiff } from '../../../src/main/git/lineage-git-diff'
import * as statusModule from '../../../src/main/git/status'
import * as runnerModule from '../../../src/main/git/runner'

vi.mock('node:fs')
vi.mock('../../../src/main/git/status')
vi.mock('../../../src/main/git/runner')

describe('lineage-git-diff', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns original and modified file contents', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(runnerModule.gitExecFileAsync).mockResolvedValue({
      stdout: '@@ -1,3 +1,4 @@\n line1\n+line2\n line3\n',
      stderr: ''
    })
    vi.mocked(statusModule.getDiff).mockResolvedValue({
      kind: 'text',
      originalContent: 'line1\nline3\n',
      modifiedContent: 'line1\nline2\nline3\n',
      originalIsBinary: false,
      modifiedIsBinary: false
    })

    const result = await getLineageFileDiff({
      childWorktreeId: 'wt-child-1',
      worktreePath: '/Users/u004767/orca/workspaces/billing-service/feature-x',
      filePath: 'src/billing.ts',
      staged: false
    })

    expect(result.status).toBe(200)
    expect(result.original).toBe('line1\nline3\n')
    expect(result.modified).toBe('line1\nline2\nline3\n')
    expect(result.patch).toContain('@@ -1,3 +1,4 @@')
  })

  it('returns 404 when file does not exist on disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false)

    const result = await getLineageFileDiff({
      childWorktreeId: 'wt-child-1',
      worktreePath: '/Users/u004767/orca/workspaces/billing-service/feature-x',
      filePath: 'src/non-existent.ts',
      staged: false
    })

    expect(result.status).toBe(404)
    expect(result.error).toContain('File not found')
  })

  it('returns 500 when diff operation throws an unexpected error', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true)
    vi.mocked(runnerModule.gitExecFileAsync).mockRejectedValue(
      new Error('Git fatal: repository corrupt')
    )
    vi.mocked(statusModule.getDiff).mockRejectedValue(new Error('Git fatal: repository corrupt'))

    const result = await getLineageFileDiff({
      childWorktreeId: 'wt-child-1',
      worktreePath: '/Users/u004767/orca/workspaces/billing-service/feature-x',
      filePath: 'src/billing.ts',
      staged: false
    })

    expect(result.status).toBe(500)
    expect(result.error).toContain('Git fatal: repository corrupt')
  })
})
