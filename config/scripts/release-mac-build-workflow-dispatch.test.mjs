import { describe, expect, it, vi } from 'vitest'

import {
  executeReleaseMacBuildMode,
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
  it('passes the shared JavaScript commit only when the parent produced a bundle', async () => {
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(200, { workflow_run_id: 123 }),
      jsonResponse(200, { id: 123, status: 'completed', conclusion: 'success' })
    ])
    await runReleaseMacBuildWorkflow(
      { ...baseOptions, javascriptSourceSha: 'a'.repeat(40) },
      { fetch, now: () => Date.parse('2026-06-30T12:00:00Z'), sleep: vi.fn() }
    )
    expect(requests[0].body.inputs).toEqual({
      release_run_id: '777',
      tag: 'v1.2.3-rc.4',
      javascript_source_sha: 'a'.repeat(40)
    })
  })
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

  it('does not accept a combined-mode success first observed after its polling deadline', async () => {
    let currentTime = Date.parse('2026-06-30T12:00:00Z')
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(200, { workflow_run_id: 123 }),
      jsonResponse(200, { id: 123, status: 'in_progress', conclusion: null }),
      jsonResponse(200, { id: 123, status: 'completed', conclusion: 'success' })
    ])
    await expect(
      runReleaseMacBuildWorkflow(baseOptions, {
        fetch,
        now: () => currentTime,
        sleep: async () => {
          currentTime += 3 * 60 * 1000
        }
      })
    ).rejects.toThrow(/Timed out after 2m/)
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET'])
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

const splitEnvironment = {
  GITHUB_REPOSITORY: 'stablyai/orca',
  GITHUB_RUN_ID: '777',
  GITHUB_TOKEN: 'token',
  GITHUB_OUTPUT: '/tmp/mac-build-output',
  RELEASE_MAC_BUILD_REF: 'main',
  RELEASE_MAC_BUILD_TAG: 'v1.2.3-rc.4',
  RELEASE_MAC_BUILD_RUN_ID: '123',
  RELEASE_MAC_BUILD_WORKFLOW_SHA: 'a'.repeat(40),
  RELEASE_MAC_BUILD_RUN_ATTEMPT: '1',
  RELEASE_MAC_BUILD_WAIT_DEADLINE_MS: String(Date.parse('2026-06-30T13:30:00Z'))
}
const splitRun = {
  id: 123,
  run_attempt: 1,
  head_sha: 'a'.repeat(40),
  head_branch: 'main',
  path: '.github/workflows/release-mac-build.yml',
  event: 'workflow_dispatch',
  display_title: 'Mac release build v1.2.3-rc.4 (777)',
  html_url: 'https://github.test/stablyai/orca/actions/runs/123',
  updated_at: '2026-06-30T12:10:00Z',
  status: 'completed',
  conclusion: 'success'
}

describe('release mac build split dispatch and verification', () => {
  it('waits for the exact dispatched run metadata to become consistent', async () => {
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(200, { workflow_run_id: 123 }),
      jsonResponse(200, { ...splitRun, display_title: 'Release macOS Build', run_attempt: 0 }),
      jsonResponse(200, splitRun)
    ])
    const sleep = vi.fn()
    const appendOutput = vi.fn()
    await expect(
      executeReleaseMacBuildMode('dispatch', splitEnvironment, { fetch, sleep, appendOutput })
    ).resolves.toMatchObject({ id: 123 })
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET', 'GET'])
    expect(requests.slice(1).map((request) => request.path)).toEqual([
      '/repos/stablyai/orca/actions/runs/123',
      '/repos/stablyai/orca/actions/runs/123'
    ])
    expect(sleep).toHaveBeenCalledWith(5_000)
    expect(appendOutput).toHaveBeenCalledOnce()
  })

  it('rejects persistently mismatched metadata without redispatching or recording outputs', async () => {
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(200, { workflow_run_id: 123 }),
      ...Array.from({ length: 7 }, () =>
        jsonResponse(200, { ...splitRun, display_title: 'Another release' })
      )
    ])
    const sleep = vi.fn()
    const appendOutput = vi.fn()
    await expect(
      executeReleaseMacBuildMode('dispatch', splitEnvironment, { fetch, sleep, appendOutput })
    ).rejects.toThrow(/does not match/)
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
    expect(sleep).toHaveBeenCalledTimes(6)
    expect(appendOutput).not.toHaveBeenCalled()
  })

  it('returns a live run identity without holding a runner while macOS builds', async () => {
    const live = { ...splitRun, status: 'in_progress', conclusion: null }
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(200, { workflow_run_id: 123, html_url: live.html_url }),
      jsonResponse(200, live)
    ])
    const appendOutput = vi.fn()
    const result = await executeReleaseMacBuildMode('dispatch', splitEnvironment, {
      fetch,
      appendOutput,
      now: () => Date.parse('2026-06-30T12:00:00Z')
    })
    expect(result.status).toBe('in_progress')
    expect(requests.map((request) => request.method)).toEqual(['POST', 'GET'])
    expect(requests[0].headers['X-GitHub-Api-Version']).toBe('2026-03-10')
    expect(appendOutput).toHaveBeenCalledWith(
      splitEnvironment.GITHUB_OUTPUT,
      `run_id=123\nworkflow_sha=${splitRun.head_sha}\nrun_attempt=1\nwait_deadline_ms=${splitEnvironment.RELEASE_MAC_BUILD_WAIT_DEADLINE_MS}\n`
    )
  })

  it.each([null, {}, { workflow_run_id: 0 }, { workflow_run_id: -1 }, { workflow_run_id: 1.5 }])(
    'fails closed when a dispatch response cannot identify its exact child: %j',
    async (response) => {
      const { fetch, requests } = createGitHubFetch([
        jsonResponse(response == null ? 204 : 200, response),
        jsonResponse(200, { workflow_runs: [splitRun] })
      ])
      const appendOutput = vi.fn()
      await expect(
        executeReleaseMacBuildMode('dispatch', splitEnvironment, {
          fetch,
          appendOutput,
          now: () => Date.parse('2026-06-30T12:00:00Z')
        })
      ).rejects.toThrow(/refusing ambiguous discovery/)
      expect(requests.map((request) => request.method)).toEqual(['POST'])
      expect(appendOutput).not.toHaveBeenCalled()
    }
  )

  it('verifies the recorded run without issuing another dispatch', async () => {
    const { fetch, requests } = createGitHubFetch([jsonResponse(200, splitRun)])
    const result = await executeReleaseMacBuildMode('wait', splitEnvironment, {
      fetch,
      now: () => Date.parse('2026-06-30T12:11:00Z')
    })
    expect(result.id).toBe(123)
    expect(requests.map((request) => request.method)).toEqual(['GET'])
  })

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', null])(
    'blocks publication for the terminal conclusion %s',
    async (conclusion) => {
      const { fetch } = createGitHubFetch([jsonResponse(200, { ...splitRun, conclusion })])
      await expect(
        executeReleaseMacBuildMode('wait', splitEnvironment, {
          fetch,
          now: () => Date.parse('2026-06-30T12:11:00Z')
        })
      ).rejects.toThrow(/concluded/)
    }
  )

  it.each([
    ['id', 124],
    ['head_sha', 'b'.repeat(40)],
    ['head_branch', 'other'],
    ['run_attempt', 2],
    ['event', 'pull_request'],
    ['path', '.github/workflows/other.yml'],
    ['display_title', 'Mac release build v1.2.4 (777)']
  ])('rejects a changed %s before inspecting success', async (field, value) => {
    const { fetch } = createGitHubFetch([jsonResponse(200, { ...splitRun, [field]: value })])
    await expect(
      executeReleaseMacBuildMode('wait', splitEnvironment, {
        fetch,
        now: () => Date.parse('2026-06-30T12:11:00Z')
      })
    ).rejects.toThrow(/does not match/)
  })

  it('accepts a run completed within its original deadline after a slow Windows build', async () => {
    const { fetch } = createGitHubFetch([jsonResponse(200, splitRun)])
    await expect(
      executeReleaseMacBuildMode('wait', splitEnvironment, {
        fetch,
        now: () => Date.parse('2026-06-30T17:00:00Z')
      })
    ).resolves.toMatchObject({ conclusion: 'success' })
  })

  it('rejects a successful run that exceeded its original deadline', async () => {
    const { fetch } = createGitHubFetch([
      jsonResponse(200, { ...splitRun, updated_at: '2026-06-30T13:31:00Z' })
    ])
    await expect(
      executeReleaseMacBuildMode('wait', splitEnvironment, {
        fetch,
        now: () => Date.parse('2026-06-30T17:00:00Z')
      })
    ).rejects.toThrow(/exceeded its original deadline/)
  })

  it('permits only the first late wait-only observation', async () => {
    let currentTime = Date.parse('2026-06-30T13:29:59Z')
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(200, { ...splitRun, status: 'in_progress', conclusion: null }),
      jsonResponse(200, splitRun)
    ])
    await expect(
      executeReleaseMacBuildMode('wait', splitEnvironment, {
        fetch,
        now: () => currentTime,
        sleep: async () => {
          currentTime += 2_000
        }
      })
    ).rejects.toThrow(/Timed out/)
    expect(requests).toHaveLength(1)
  })

  it('does not reset the polling deadline after the Windows build finishes', async () => {
    const { fetch, requests } = createGitHubFetch([
      jsonResponse(200, { ...splitRun, status: 'in_progress', conclusion: null })
    ])
    const sleep = vi.fn()
    await expect(
      executeReleaseMacBuildMode('wait', splitEnvironment, {
        fetch,
        sleep,
        now: () => Date.parse('2026-06-30T17:00:00Z')
      })
    ).rejects.toThrow(/Timed out/)
    expect(requests).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it.each([
    ['RELEASE_MAC_BUILD_RUN_ID', ''],
    ['RELEASE_MAC_BUILD_RUN_ID', '../456'],
    ['RELEASE_MAC_BUILD_WORKFLOW_SHA', ''],
    ['RELEASE_MAC_BUILD_RUN_ATTEMPT', ''],
    ['RELEASE_MAC_BUILD_WAIT_DEADLINE_MS', '']
  ])('fails closed without valid %s', async (field, value) => {
    const fetch = vi.fn()
    await expect(
      executeReleaseMacBuildMode(
        'wait',
        {
          ...splitEnvironment,
          [field]: value
        },
        { fetch }
      )
    ).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
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
      headers: init.headers,
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
