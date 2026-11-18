import { describe, expect, it } from 'vitest'
import {
  EVAL_OWNER_GH_LOGIN,
  GH_SIGNED_OUT_CODE,
  GH_SIGNED_OUT_STDERR,
  runGh
} from './bot-automation-eval-gh'
import { GITHUB } from '../bot-orchestration-eval/bot-orchestration-eval-identity-fixtures'

const io = { stdin: () => 'from stdin', files: () => 'from a file' }
const gh = (...argv: string[]) => runGh(GITHUB, argv, io)

describe('the owner gh stand-in', () => {
  it('reads an issue by number and repo, by URL and as JSON', () => {
    expect(gh('issue', 'view', '12971', '-R', 'stablyai/orca').stdout).toContain(
      'Terminal freezes after waking'
    )
    expect(
      gh('issue', 'view', 'https://github.com/acme/api/issues/17', '--comments').stdout
    ).toContain('never schedules a retry')
    expect(
      JSON.parse(gh('pr', 'view', '18', '-R', 'acme/api', '--json', 'title,headRefName').stdout)
    ).toEqual({ title: 'Retry uploads on 503', headRefName: 'sam/retry-503' })
    expect(gh('pr', 'diff', '18', '--repo=acme/api').stdout).toContain('attempt < 10')
  })

  it('reads a private repository the owner can see', () => {
    expect(gh('issue', 'view', '4', '-R', 'acme/billing', '-c').stdout).toContain('roundTax()')
  })

  it('answers a repository or number it lacks as gh does, and needs a repo outside a checkout', () => {
    expect(gh('issue', 'view', '1', '-R', 'acme/nope')).toMatchObject({
      code: 1,
      writes: []
    })
    expect(gh('issue', 'view', '99', '-R', 'acme/api').stderr).toContain('number of 99')
    expect(gh('issue', 'view', '17').stderr).toContain('not a git repository')
  })

  it('records each write with where it landed and what it said', () => {
    expect(gh('issue', 'comment', '17', '-R', 'acme/api', '--body', 'Looks good').writes).toEqual([
      {
        method: 'gh.issue.comment',
        params: expect.objectContaining({
          repo: 'acme/api',
          number: 17,
          body: 'Looks good'
        })
      }
    ])
    expect(gh('issue', 'comment', 'acme/api#17', '--body-file', '-').writes[0]?.params.body).toBe(
      'from stdin'
    )
    expect(
      gh(
        'issue',
        'edit',
        '12971',
        '-R',
        'stablyai/orca',
        '--add-label',
        'bug,p1',
        '--add-assignee',
        '@me'
      ).writes[0]?.params
    ).toMatchObject({
      addLabels: ['bug', 'p1'],
      addAssignees: [EVAL_OWNER_GH_LOGIN]
    })
  })

  it('finds only pull requests with a pr command, as gh does', () => {
    expect(gh('pr', 'comment', '17', '-R', 'acme/api', '--body', 'x')).toMatchObject({
      code: 1,
      writes: [],
      stderr: expect.stringContaining('PullRequest')
    })
    expect(gh('issue', 'view', '18', '-R', 'acme/api').code).toBe(0)
  })

  it("names a review's kind, however it is spelled", () => {
    const kind = (...flags: string[]) =>
      gh('pr', 'review', '21', '-R', 'acme/api', ...flags, '-b', 'x').writes[0]?.params.event
    expect(kind('--comment')).toBe('comment')
    expect(kind('-c')).toBe('comment')
    expect(kind('--approve')).toBe('approve')
    expect(kind('-r')).toBe('request_changes')
  })

  it('reads `gh api` paths and records its writes by what they do', () => {
    expect(JSON.parse(gh('api', 'repos/acme/api/issues/17').stdout).title).toBe(
      'Retry failed uploads'
    )
    expect(
      gh('api', 'repos/acme/api/issues/17/comments', '-f', 'body=Shipped').writes[0]
    ).toMatchObject({
      method: 'gh.issue.comment',
      params: { repo: 'acme/api', number: 17, body: 'Shipped' }
    })
    expect(
      gh('api', '-X', 'POST', 'repos/acme/api/pulls/18/reviews', '-f', 'event=COMMENT').writes[0]
    ).toMatchObject({ method: 'gh.pr.review', params: { event: 'comment' } })
  })

  it('signed out, answers every call as the real gh did and writes nothing', () => {
    const out = (...argv: string[]) => runGh({ ...GITHUB, signedOut: true }, argv, io)
    expect(out('issue', 'edit', '17', '-R', 'acme/api', '--add-label', 'bug')).toEqual({
      stdout: '',
      stderr: GH_SIGNED_OUT_STDERR,
      code: GH_SIGNED_OUT_CODE,
      writes: []
    })
    expect(out('auth', 'status')).toMatchObject({
      code: 1,
      stderr: expect.stringContaining('gh auth login')
    })
    expect(out('auth', 'token').code).toBe(1)
  })
})
