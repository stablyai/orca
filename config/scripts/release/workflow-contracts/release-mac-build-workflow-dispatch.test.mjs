import { describe, expect, it, vi } from 'vitest'
import { executeReleaseMacBuildMode } from '../operations/run-release-mac-build-workflow.mjs'

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
