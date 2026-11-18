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
