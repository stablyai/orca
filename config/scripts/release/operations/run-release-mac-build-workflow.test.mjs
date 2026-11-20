import { describe, expect, it } from 'vitest'
import { executeReleaseMacBuildMode } from './run-release-mac-build-workflow.mjs'

const RUN_ID = 4455
const HEAD_SHA = 'a'.repeat(40)
const env = {
  GITHUB_OUTPUT: '/tmp/unused-output',
  GITHUB_REPOSITORY: 'stablyai/orca',
  GITHUB_TOKEN: 'token',
  RELEASE_MAC_BUILD_REF: 'main',
  RELEASE_MAC_BUILD_RELEASE_RUN_ID: '900',
  RELEASE_MAC_BUILD_TAG: 'v1.4.999'
}

function jsonResponse(status, body) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) }
}

function runBody() {
  return {
    id: RUN_ID,
    event: 'workflow_dispatch',
    path: '.github/workflows/release-mac-build.yml',
    display_title: 'Mac release build v1.4.999 (900)',
    head_branch: 'main',
    head_sha: HEAD_SHA,
    run_attempt: 1
  }
}

function fetchWith(runReadStatuses) {
  const reads = []
  const fetch = async (url, init) => {
    if (init.method === 'POST') {
      return jsonResponse(200, { workflow_run_id: RUN_ID, html_url: 'https://example.test/run' })
    }
    reads.push(url)
    const status = runReadStatuses.shift() ?? 200
    return status === 200
      ? jsonResponse(200, runBody())
      : jsonResponse(status, { message: 'Not Found' })
  }
  return { fetch, reads }
}

async function dispatch(runReadStatuses) {
  const { fetch, reads } = fetchWith(runReadStatuses)
  const sleeps = []
  const outputs = []
  const run = await executeReleaseMacBuildMode('dispatch', env, {
    fetch,
    sleep: async (ms) => sleeps.push(ms),
    appendOutput: (_path, text) => outputs.push(text)
  })
  return { run, reads, sleeps, outputs }
}

describe('dispatching the mac release build', () => {
  it('waits through a 404 on the run it just dispatched', async () => {
    const { run, reads, sleeps, outputs } = await dispatch([404, 404, 200])
    expect(run.id).toBe(RUN_ID)
    expect(reads).toHaveLength(3)
    expect(sleeps).toEqual([5_000, 5_000])
    expect(outputs[0]).toContain(`run_id=${RUN_ID}`)
  })

  it('gives up with the 404 after about a minute of waiting', async () => {
    await expect(dispatch(Array(20).fill(404))).rejects.toThrow('failed with 404')
  })

  it('does not retry other API errors', async () => {
    await expect(dispatch([401])).rejects.toThrow('failed with 401')
  })
})
