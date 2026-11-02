import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import {
  buildMessage,
  decideTransition,
  main,
  mention,
  parseSlackUserIds
} from './main-health-alert.mjs'

const run = (run_number, conclusion, extra = {}) => ({
  id: 1000 + run_number,
  run_number,
  status: 'completed',
  conclusion,
  ...extra
})

describe('main health transitions', () => {
  it.each([
    ['green to red alerts', 'success', 'failure', 'broken'],
    ['red to green recovers', 'failure', 'success', 'recovered'],
    ['red stays red', 'failure', 'failure', 'none'],
    ['green stays green', 'success', 'success', 'none'],
    ['a timeout counts as red', 'success', 'timed_out', 'broken']
  ])('%s', (_name, before, now, action) => {
    expect(decideTransition(run(2, now), [run(1, before), run(2, now)]).action).toBe(action)
  })

  it('never reports a cancelled or skipped run', () => {
    for (const conclusion of ['cancelled', 'skipped', 'neutral']) {
      expect(decideTransition(run(2, conclusion), [run(1, 'success')]).action).toBe('none')
    }
  })

  it('looks past cancelled runs to the last settled state', () => {
    const runs = [run(1, 'failure'), run(2, 'cancelled'), run(3, 'success')]
    expect(decideTransition(run(3, 'success'), runs).action).toBe('recovered')
  })

  it('lets only the newest settled run speak when runs finish out of order', () => {
    const runs = [run(1, 'success'), run(2, 'failure'), run(3, 'success')]
    expect(decideTransition(run(2, 'failure'), runs).action).toBe('none')
  })

  it('announces the first failure when there is no earlier main run', () => {
    expect(decideTransition(run(1, 'failure'), [run(1, 'failure')]).action).toBe('broken')
  })

  it('recovers when a red run passes on re-run', () => {
    const runs = [run(1, 'success'), run(2, 'success')]
    expect(decideTransition(run(2, 'success'), runs, { conclusion: 'failure' }).action).toBe(
      'recovered'
    )
  })
})

describe('Slack mentions', () => {
  it('uses a configured Slack member ID and falls back to the GitHub profile link', () => {
    const ids = parseSlackUserIds('{"octocat":"U0123ABC"}')
    expect(mention('octocat', ids)).toBe('<@U0123ABC>')
    expect(mention('someone', ids)).toBe('<https://github.com/someone|@someone>')
    expect(parseSlackUserIds('')).toEqual({})
    expect(() => parseSlackUserIds('[]')).toThrow()
  })

  it('names the merger and author, the failed jobs and the run', () => {
    const message = buildMessage({
      action: 'broken',
      run: {
        head_sha: 'a'.repeat(40),
        html_url: 'https://github.com/o/r/actions/runs/9',
        head_commit: { message: 'Fix <thing>\n\nbody' }
      },
      pullRequest: {
        number: 7,
        title: 'Fix <thing>',
        html_url: 'https://github.com/o/r/pull/7',
        user: { login: 'author' },
        merged_by: { login: 'merger' }
      },
      failedJobs: Array.from({ length: 12 }, (_, i) => `job ${i}`),
      slackUserIds: { merger: 'U1' },
      repoUrl: 'https://github.com/o/r'
    })
    expect(message).toContain(
      '<https://github.com/o/r/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|`aaaaaaaaaaaa`>'
    )
    expect(message).toContain('<https://github.com/o/r/pull/7|#7 Fix &lt;thing&gt;>')
    expect(message).toContain('<@U1> <https://github.com/author|@author>')
    expect(message).toContain('• job 9\n• …and 2 more')
    expect(message).toContain('<https://github.com/o/r/actions/runs/9|Open the run>')
  })
})

describe('alert run', () => {
  const runs = {
    9: {
      ...run(9, 'failure'),
      event: 'push',
      head_branch: 'main',
      workflow_id: 5,
      head_sha: 'b'.repeat(40),
      html_url: 'https://github.com/o/r/actions/runs/1009',
      run_attempt: 1
    }
  }
  const routes = {
    '/repos/o/r/actions/runs/1009': runs[9],
    '/repos/o/r/actions/workflows/5/runs?branch=main&event=push&status=completed&per_page=100': {
      workflow_runs: [run(8, 'success'), runs[9]]
    },
    [`/repos/o/r/commits/${'b'.repeat(40)}/pulls`]: [{ number: 3, merged_at: 'x' }],
    '/repos/o/r/pulls/3': {
      number: 3,
      title: 'Change',
      html_url: 'https://github.com/o/r/pull/3',
      user: { login: 'dev' }
    },
    '/repos/o/r/actions/runs/1009/jobs?filter=latest&per_page=100': {
      jobs: [
        { name: 'static analysis and typecheck', conclusion: 'failure' },
        { name: 'package', conclusion: 'success' }
      ]
    }
  }
  const request = vi.fn(async (url) => {
    const route = url.replace('https://api.github.com', '')
    if (!(route in routes)) {
      throw new Error(`unexpected ${url}`)
    }
    return { ok: true, json: async () => routes[route] }
  })

  it('prints the payload instead of posting without a webhook', async () => {
    const log = vi.fn()
    const payload = await main(
      { GITHUB_REPOSITORY: 'o/r', RUN_ID: '1009', GH_TOKEN: 't' },
      { request, log }
    )
    expect(payload.text).toContain('main is red')
    expect(payload.text).toContain('• static analysis and typecheck')
    expect(payload.text).not.toContain('• package')
    expect(request.mock.calls.every(([url]) => url.startsWith('https://api.github.com'))).toBe(true)
    expect(log.mock.calls[0][0]).toContain('Dry run')
  })

  it('posts once to the webhook when one is configured', async () => {
    request.mockClear()
    const post = vi.fn(async () => ({ ok: true }))
    await main(
      {
        GITHUB_REPOSITORY: 'o/r',
        RUN_ID: '1009',
        GH_TOKEN: 't',
        SLACK_WEBHOOK_URL: 'https://hooks.slack.test/x'
      },
      {
        request: (url, options) =>
          url.startsWith('https://hooks') ? post(url, options) : request(url, options),
        log: vi.fn()
      }
    )
    expect(post).toHaveBeenCalledTimes(1)
    expect(JSON.parse(post.mock.calls[0][1].body).blocks[0].text.text).toContain('main is red')
  })
})

describe('alert workflow', () => {
  const workflow = parse(readFileSync('.github/workflows/main-health-alert.yml', 'utf8'))
  const job = workflow.jobs.alert

  it('follows completed main PR Checks pushes and skips cancelled runs', () => {
    expect(workflow.on.workflow_run).toEqual({
      workflows: ['PR Checks'],
      types: ['completed'],
      branches: ['main']
    })
    expect(job.if).toContain("github.event.workflow_run.event == 'push'")
    expect(job.if).toContain("github.event.workflow_run.conclusion != 'cancelled'")
    expect(workflow.concurrency).toBeUndefined()
  })

  it('reuses the release Slack webhook secret', () => {
    const step = job.steps.find((candidate) => candidate.run?.includes('main-health-alert.mjs'))
    expect(step.env.SLACK_WEBHOOK_URL).toBe('${{ secrets.SLACK_WEBHOOK_URL }}')
    expect(step.env.RUN_ID).toBe('${{ github.event.workflow_run.id }}')
  })
})
