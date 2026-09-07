import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  glabExecFileAsyncMock,
  getGlabKnownHostsMock,
  resolveIssueSourceMock,
  glabRepoExecOptionsMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  glabExecFileAsyncMock: vi.fn(),
  getGlabKnownHostsMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  glabRepoExecOptionsMock: vi.fn(
    (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions: { wslDistro?: string } = {}
    ) => (connectionId ? {} : { cwd: repoPath, ...localGitOptions })
  ),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gl-utils', () => ({
  acquire: acquireMock,
  release: releaseMock,
  getGlabKnownHosts: getGlabKnownHostsMock,
  resolveIssueSource: resolveIssueSourceMock,
  glabExecFileAsync: glabExecFileAsyncMock,
  glabHostnameArgs: vi.fn(() => []),
  glabRepoExecOptions: glabRepoExecOptionsMock
}))

import { countDiffLines } from './mr-file-diffs'
import { getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails', () => {
  beforeEach(() => {
    glabExecFileAsyncMock.mockReset()
    getGlabKnownHostsMock.mockReset()
    resolveIssueSourceMock.mockReset()
    glabRepoExecOptionsMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
    resolveIssueSourceMock.mockResolvedValue({
      source: { host: 'gitlab.com', path: 'g/p' },
      fellBack: false
    })
  })

  it('caps MR detail discussions, jobs, and file diffs to one API page', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            title: 'Bound detail payloads',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-05-31T12:00:00Z',
            source_branch: 'feature/bounds',
            target_branch: 'main',
            description: 'MR body',
            sha: 'head-sha',
            diff_refs: { base_sha: 'base-sha', start_sha: 'start-sha' },
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 'discussion-1',
              notes: [
                {
                  id: 1,
                  body: 'Review note',
                  created_at: '2026-05-31T12:01:00Z',
                  author: { username: 'alice', avatar_url: 'https://example.com/a.png' }
                }
              ]
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/jobs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              name: 'verify',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/10',
              duration: 12
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/bridges?per_page=100') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/reviewers') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approvals') {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approval_state') {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/diffs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              new_path: 'src/app.ts',
              old_path: 'src/app.ts',
              diff: '@@ -1 +1 @@\n-old\n+new'
            }
          ])
        }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')

    expect(details?.comments).toHaveLength(1)
    expect(details?.pipelineJobs).toHaveLength(1)
    expect(details?.files).toHaveLength(1)
    expect(details?.files?.[0]).toMatchObject({
      path: 'src/app.ts',
      additions: 1,
      deletions: 1
    })
    expect(glabExecFileAsyncMock.mock.calls.map(([args]) => args)).toContainEqual([
      'api',
      'projects/g%2Fp/merge_requests/12/diffs?per_page=100'
    ])
    expect(glabExecFileAsyncMock.mock.calls.flatMap(([args]) => args)).not.toContain('--paginate')
  })

  it('expands bridge child-pipeline jobs into the checks list', async () => {
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            title: 'Bridge pipeline',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-05-31T12:00:00Z',
            source_branch: 'feature/bridges',
            target_branch: 'main',
            description: 'MR body',
            sha: 'head-sha',
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/jobs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 10,
              name: 'semgrep-sast',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/10',
              duration: 12
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/bridges?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 50,
              name: 'trigger-ci',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/50',
              downstream_pipeline: {
                id: 200,
                status: 'failed',
                web_url: 'https://gitlab.com/g/p/-/pipelines/200'
              }
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/200/jobs?per_page=100') {
        return {
          stdout: JSON.stringify([
            {
              id: 300,
              name: 'unit',
              stage: 'test',
              status: 'failed',
              web_url: 'https://gitlab.com/g/p/-/jobs/300',
              duration: 40
            },
            {
              id: 301,
              name: 'lint',
              stage: 'test',
              status: 'success',
              web_url: 'https://gitlab.com/g/p/-/jobs/301',
              duration: 20
            }
          ])
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/reviewers') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approvals') {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approval_state') {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/diffs?per_page=100') {
        return { stdout: '[]' }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')
    const names = (details?.pipelineJobs ?? []).map((job) => job.name).sort()
    expect(names).toEqual(['lint', 'semgrep-sast', 'trigger-ci', 'unit'])
    expect(details?.pipelineJobs?.find((job) => job.name === 'unit')).toMatchObject({
      id: 300,
      status: 'failed',
      pipelineId: 200
    })
    expect(details?.pipelineJobs?.find((job) => job.name === 'trigger-ci')).toMatchObject({
      id: 0,
      status: 'failed',
      pipelineId: 99
    })
  })

  // Why: each fetch spawns a `glab` binary (a remote exec over SSH) and this runs on the Checks
  // poll timer, so a bridge-heavy MR must trickle its children rather than burst them.
  it('bounds concurrent child-pipeline fetches', async () => {
    const BRIDGE_COUNT = 25
    let inFlightJobPages = 0
    let peakJobPages = 0

    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1) as string
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            iid: 12,
            title: 'Fan out',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-05-31T12:00:00Z',
            source_branch: 'f',
            target_branch: 'main',
            sha: 'head-sha',
            head_pipeline: { id: 99 }
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/pipelines/99/bridges?per_page=100') {
        return {
          stdout: JSON.stringify(
            Array.from({ length: BRIDGE_COUNT }, (_, i) => ({
              id: 500 + i,
              name: `trigger-${i}`,
              stage: 'trigger',
              status: 'success',
              downstream_pipeline: {
                id: 1000 + i,
                status: 'running',
                web_url: `https://gitlab.com/g/p/-/pipelines/${1000 + i}`
              }
            }))
          )
        }
      }
      if (/pipelines\/\d+\/jobs/.test(endpoint)) {
        inFlightJobPages += 1
        peakJobPages = Math.max(peakJobPages, inFlightJobPages)
        await new Promise((resolve) => setTimeout(resolve, 2))
        inFlightJobPages -= 1
        return { stdout: '[]' }
      }
      if (endpoint.endsWith('/approvals')) {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint.endsWith('/approval_state')) {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      return { stdout: '[]' }
    })

    const details = await getWorkItemDetails('/repo', 12, 'mr')
    // Parent page can overlap the capped child pool, so allow one above the child limit.
    expect(peakJobPages).toBeLessThanOrEqual(5)
    // Every bridge still gets a rollup row even past the 20-child expansion cap.
    expect(details?.pipelineJobs).toHaveLength(BRIDGE_COUNT)
  })

  it('routes local WSL MR detail fetches through project resolution and glab options', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    glabExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.at(-1)
      if (endpoint === 'projects/g%2Fp/merge_requests/12') {
        return {
          stdout: JSON.stringify({
            id: 120,
            iid: 12,
            title: 'WSL detail',
            state: 'opened',
            web_url: 'https://gitlab.com/g/p/-/merge_requests/12',
            updated_at: '2026-06-16T00:00:00Z',
            description: 'MR body',
            sha: 'head-sha',
            head_pipeline: null,
            reviewers: []
          })
        }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/discussions?per_page=100') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/reviewers') {
        return { stdout: '[]' }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approvals') {
        return { stdout: JSON.stringify({ approvals_required: 0, approvals_left: 0 }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/approval_state') {
        return { stdout: JSON.stringify({ rules: [] }) }
      }
      if (endpoint === 'projects/g%2Fp/merge_requests/12/diffs?per_page=100') {
        return { stdout: '[]' }
      }
      throw new Error(`unexpected glab call: ${args.join(' ')}`)
    })

    const details = await getWorkItemDetails(
      '/repo',
      12,
      'mr',
      undefined,
      null,
      undefined,
      localGitOptions
    )

    expect(details?.item.number).toBe(12)
    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo',
      undefined,
      ['gitlab.com'],
      null,
      localGitOptions
    )
    expect(glabExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
  })
})

describe('countDiffLines', () => {
  it('counts added and removed lines inside a hunk', () => {
    expect(countDiffLines('@@ -1 +1 @@\n-old\n+new')).toEqual({ additions: 1, deletions: 1 })
  })

  it('counts a removed line whose original content began with `--` (SQL/Lua comment)', () => {
    // Why: prefix `-` + content `-- old comment` = diff line `--- old comment`,
    // which collides with the `--- a/file` header under a plain startsWith check.
    expect(
      countDiffLines('--- a/db.sql\n+++ b/db.sql\n@@ -1,2 +1,2 @@\n keep\n--- old comment\n+new')
    ).toEqual({ additions: 1, deletions: 1 })
  })

  it('counts an added line whose original content began with `++`', () => {
    // Why: prefix `+` + content `++ flag` = diff line `+++ flag`, colliding with `+++ b/file`.
    expect(countDiffLines('--- a/f.lua\n+++ b/f.lua\n@@ -1 +1 @@\n-old\n+++ flag')).toEqual({
      additions: 1,
      deletions: 1
    })
  })

  it('counts the collision on a header-less payload, the shape GitLab actually returns', () => {
    // Why: the `/diffs` entity emits `json_safe_diff`, which starts at `@@` — the
    // `--- a/file` form is opt-in via `unidiff=true`, which this call path never sends.
    // So this, not the header-prefixed variant, is the reachable regression input.
    expect(countDiffLines('@@ -1 +1 @@\n--- old comment\n+++ new comment')).toEqual({
      additions: 1,
      deletions: 1
    })
  })

  it('counts an added line of `++i;` C-style increment content', () => {
    expect(countDiffLines('@@ -1 +1 @@\n-i++;\n+++i;')).toEqual({ additions: 1, deletions: 1 })
  })

  it('yields zero for a binary-notice diff', () => {
    expect(countDiffLines('Binary files a/logo.png and b/logo.png differ')).toEqual({
      additions: 0,
      deletions: 0
    })
  })

  it('skips file headers before the first hunk and yields zero for a header-only diff', () => {
    expect(countDiffLines('--- a/x\n+++ b/x')).toEqual({ additions: 0, deletions: 0 })
  })

  it('keeps additions and deletions distinct under an asymmetric hunk', () => {
    expect(countDiffLines('@@ -1 +1,2 @@\n-old\n+a\n+b')).toEqual({ additions: 2, deletions: 1 })
  })

  it('accumulates counts across multiple hunks', () => {
    expect(countDiffLines('@@ -1 +1 @@\n-a\n+b\n@@ -5 +5,2 @@\n-c\n+d\n+e')).toEqual({
      additions: 3,
      deletions: 2
    })
  })

  it('yields zero for the empty diff that binary and rename-only files carry', () => {
    // Why: mapMRFile passes `raw.diff ?? ''`, so binary/too_large/rename-only entries land here.
    expect(countDiffLines('')).toEqual({ additions: 0, deletions: 0 })
  })

  it('yields zero when no hunk header is present, even with +/- lines', () => {
    // Why: pins the deliberate behaviour change — without a `@@` there is no hunk, so
    // leading +/- can only be file headers. Counting them is what caused the collision.
    expect(countDiffLines('+added\n-removed')).toEqual({ additions: 0, deletions: 0 })
  })

  it('ignores the no-newline marker and a trailing newline', () => {
    expect(countDiffLines('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file\n')).toEqual({
      additions: 1,
      deletions: 1
    })
  })

  it('counts hunk content whose own text begins with `@@`', () => {
    // Why: the `@@` hunk check runs first, so it must not swallow `+`/`-` content.
    expect(countDiffLines('@@ -1 +1 @@\n-@@ old\n+@@ new')).toEqual({ additions: 1, deletions: 1 })
  })
})
