import { describe, expect, it, vi } from 'vitest'

import {
  expectedReleaseMacBuildRunTitle,
  readReleaseMacBuildWorkflowOptions,
  runReleaseMacBuildWorkflow
} from './run-release-mac-build-workflow.mjs'

const baseOptions = {
  apiBaseUrl: 'https://api.github.test',
  pollSeconds: 1,
  ref: 'main',
  releaseRunId: '777',
  repo: 'stablyai/orca',
  tag: 'v1.2.3-rc.4',
  timeoutMinutes: 2,
  token: 'token',
  workflow: 'release-mac-build.yml'
}

describe('release mac build workflow dispatch', () => {
  it('dispatches the mac workflow and waits for the returned run id', async () => {
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(200, {
        html_url: 'https://github.test/stablyai/orca/actions/runs/123',
        workflow_run_id: 123
      }),
      jsonResponse(200, {
        conclusion: 'success',
        html_url: 'https://github.test/stablyai/orca/actions/runs/123',
        id: 123,
        status: 'completed'
      })
    ])

    const completedRun = await runReleaseMacBuildWorkflow(baseOptions, {
      fetch,
      now: () => Date.parse('2026-06-30T12:00:00Z'),
      sleep: vi.fn()
    })

    expect(completedRun.conclusion).toBe('success')
    expect(requests[0].method).toBe('POST')
    expect(requests[0].path).toBe(
      '/repos/stablyai/orca/actions/workflows/release-mac-build.yml/dispatches'
    )
    expect(requests[0].body).toEqual({
      inputs: {
        release_run_id: '777',
        tag: 'v1.2.3-rc.4'
      },
      ref: 'main'
    })
    expect(requests[1].path).toBe('/repos/stablyai/orca/actions/runs/123')
  })

  it('finds the dispatched run by release tag and parent run id when GitHub returns no body', async () => {
    const runTitle = expectedReleaseMacBuildRunTitle(baseOptions)
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(204, null),
      jsonResponse(200, {
        workflow_runs: [
          {
            created_at: '2026-06-30T11:59:00Z',
            display_title: runTitle,
            id: 122
          },
          {
            created_at: '2026-06-30T12:00:01Z',
            display_title: runTitle,
            html_url: 'https://github.test/stablyai/orca/actions/runs/124',
            id: 124
          }
        ]
      }),
      jsonResponse(200, {
        conclusion: 'success',
        html_url: 'https://github.test/stablyai/orca/actions/runs/124',
        id: 124,
        status: 'completed'
      })
    ])

    const completedRun = await runReleaseMacBuildWorkflow(baseOptions, {
      fetch,
      now: () => Date.parse('2026-06-30T12:00:05Z'),
      sleep: vi.fn()
    })

    expect(completedRun.id).toBe(124)
    expect(requests[1].path).toBe(
      '/repos/stablyai/orca/actions/workflows/release-mac-build.yml/runs'
    )
    expect(requests[1].query.get('event')).toBe('workflow_dispatch')
  })

  it('fails when the isolated mac workflow does not succeed', async () => {
    const { fetch } = createGitHubFetch([
      jsonResponse(200, {
        html_url: 'https://github.test/stablyai/orca/actions/runs/125',
        workflow_run_id: 125
      }),
      jsonResponse(200, {
        conclusion: 'failure',
        html_url: 'https://github.test/stablyai/orca/actions/runs/125',
        id: 125,
        status: 'completed'
      })
    ])

    await expect(
      runReleaseMacBuildWorkflow(baseOptions, {
        fetch,
        now: () => Date.parse('2026-06-30T12:00:00Z'),
        sleep: vi.fn()
      })
    ).rejects.toThrow(/concluded failure/)
  })

  it('reads required workflow settings from the GitHub Actions environment', () => {
    const options = readReleaseMacBuildWorkflowOptions({
      GITHUB_REPOSITORY: 'stablyai/orca',
      GITHUB_RUN_ID: '987',
      GITHUB_TOKEN: 'token',
      RELEASE_MAC_BUILD_REF: 'main',
      RELEASE_MAC_BUILD_TAG: 'v1.2.3'
    })

    expect(options.releaseRunId).toBe('987')
    expect(options.workflow).toBe('release-mac-build.yml')
    expect(options.pollSeconds).toBe(30)
    expect(options.timeoutMinutes).toBe(90)
  })
})

function createGitHubFetch(responses) {
  const requests = []
  const fetch = vi.fn(async (rawUrl, init) => {
    const url = new URL(rawUrl)
    const response = responses.shift()

    if (response == null) {
      throw new Error(`Unexpected request: ${init.method} ${rawUrl}`)
    }

    requests.push({
      body: init.body == null ? undefined : JSON.parse(init.body),
      method: init.method,
      path: url.pathname,
      query: url.searchParams
    })

    return response
  })

  return { fetch, requests }
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body == null ? '' : JSON.stringify(body)
    }
  }
}
