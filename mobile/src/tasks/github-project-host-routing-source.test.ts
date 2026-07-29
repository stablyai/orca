import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../app/h/[hostId]/tasks.tsx', import.meta.url), 'utf8')

describe('mobile GitHub Project host routing boundary', () => {
  it('host-qualifies every Project RPC request', () => {
    const calls = [...source.matchAll(/['"](github\.project\.[^'"]+)['"]/g)]
    expect(calls.length).toBeGreaterThan(10)
    for (const call of calls) {
      const request = source.slice(call.index, call.index + 700)
      expect(request, `${call[1]} must carry a host`).toMatch(/\bhost\s*:/)
    }
  })

  it('pins Project-row PR actions to the row repository identity', () => {
    const actions = source.slice(source.indexOf('const toggleProjectGitHubReviewThread'))
    for (const method of [
      'github.resolveReviewThread',
      'github.addPRReviewCommentReply',
      'github.addIssueComment',
      'github.requestPRReviewers',
      'github.prChecks',
      'github.rerunPRChecks',
      'github.setPRFileViewed',
      'github.prFileContents',
      'github.addPRReviewComment',
      'github.mergePR'
    ]) {
      const offset = actions.indexOf(`'${method}'`)
      expect(offset, `${method} must remain wired in the Project action path`).toBeGreaterThan(-1)
      expect(actions.slice(offset, offset + 700), `${method} must carry prRepo`).toContain(
        'prRepo: projectRowGitHubRepository(row, activeGitHubProjectHost)'
      )
    }
  })

  it('pins discovery to github.com while pasted URLs supply their parsed host', () => {
    expect(source).toContain("'github.project.listAccessible', {\n      host: 'github.com'")
    expect(source).toContain('host: githubProjectHost(parsed.host)')
  })
})
