const DEFAULT_API_VERSION = '2026-03-10'
const DEFAULT_TIMEOUT_MINUTES = 90
const DEFAULT_POLL_SECONDS = 30
const RUN_DISCOVERY_TIMEOUT_SECONDS = 120

export function readReleaseMacBuildWorkflowOptions(env = process.env) {
  return {
    apiBaseUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    pollSeconds: readPositiveInteger(env.RELEASE_MAC_BUILD_POLL_SECONDS, DEFAULT_POLL_SECONDS),
    ref: requiredEnv(env.RELEASE_MAC_BUILD_REF, 'RELEASE_MAC_BUILD_REF'),
    releaseRunId: requiredEnv(
      env.RELEASE_MAC_BUILD_RELEASE_RUN_ID ?? env.GITHUB_RUN_ID,
      'RELEASE_MAC_BUILD_RELEASE_RUN_ID'
    ),
    repo: requiredEnv(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY'),
    tag: requiredEnv(env.RELEASE_MAC_BUILD_TAG, 'RELEASE_MAC_BUILD_TAG'),
    timeoutMinutes: readPositiveInteger(
      env.RELEASE_MAC_BUILD_TIMEOUT_MINUTES,
      DEFAULT_TIMEOUT_MINUTES
    ),
    token: requiredEnv(env.GITHUB_TOKEN ?? env.GH_TOKEN, 'GITHUB_TOKEN'),
    workflow: env.RELEASE_MAC_BUILD_WORKFLOW ?? 'release-mac-build.yml'
  }
}

export function expectedReleaseMacBuildRunTitle({ releaseRunId, tag }) {
  return `Mac release build ${tag} (${releaseRunId})`
}

export async function runReleaseMacBuildWorkflow(options, deps = {}) {
  const api = createGitHubApiClient(options, deps)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepMilliseconds
  const dispatchStartedAtMs = now() - 10_000
  const dispatchResult = await dispatchReleaseMacBuildWorkflow(api, options)
  const workflowRun =
    readWorkflowRunFromDispatchResult(dispatchResult) ??
    (await findDispatchedReleaseMacBuildRun(api, options, {
      dispatchStartedAtMs,
      now,
      sleep
    }))

  console.log(
    `Waiting for mac release build workflow run ${workflowRun.id}: ${workflowRun.html_url}`
  )

  const completedRun = await waitForReleaseMacBuildRun(api, workflowRun.id, options, {
    now,
    sleep
  })

  if (completedRun.conclusion !== 'success') {
    throw new Error(
      `Mac release build workflow ${completedRun.html_url ?? completedRun.id} concluded ${
        completedRun.conclusion ?? 'without a conclusion'
      }.`
    )
  }

  console.log(`Mac release build workflow succeeded: ${completedRun.html_url}`)
  return completedRun
}

export async function dispatchReleaseMacBuildWorkflow(api, options) {
  const body = {
    inputs: {
      release_run_id: options.releaseRunId,
      tag: options.tag
    },
    ref: options.ref
  }

  return await api.request(
    'POST',
    `/repos/${api.owner}/${api.repo}/actions/workflows/${encodeURIComponent(
      options.workflow
    )}/dispatches`,
    body
  )
}

export async function findDispatchedReleaseMacBuildRun(api, options, deps = {}) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepMilliseconds
  const deadlineMs = now() + RUN_DISCOVERY_TIMEOUT_SECONDS * 1000
  const expectedTitle = expectedReleaseMacBuildRunTitle(options)

  while (now() <= deadlineMs) {
    const response = await api.request(
      'GET',
      `/repos/${api.owner}/${api.repo}/actions/workflows/${encodeURIComponent(
        options.workflow
      )}/runs?event=workflow_dispatch&per_page=20`
    )
    const workflowRuns = Array.isArray(response?.workflow_runs) ? response.workflow_runs : []
    const match = workflowRuns.find((run) => {
      const createdAtMs = Date.parse(run.created_at ?? '')

      return createdAtMs >= deps.dispatchStartedAtMs && run.display_title === expectedTitle
    })

    if (match) {
      return match
    }

    await sleep(options.pollSeconds * 1000)
  }

  throw new Error(
    `Timed out finding dispatched mac release build workflow run named "${expectedTitle}".`
  )
}

export async function waitForReleaseMacBuildRun(api, workflowRunId, options, deps = {}) {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepMilliseconds
  const deadlineMs = now() + options.timeoutMinutes * 60 * 1000

  while (now() <= deadlineMs) {
    const run = await api.request(
      'GET',
      `/repos/${api.owner}/${api.repo}/actions/runs/${workflowRunId}`
    )

    if (run.status === 'completed') {
      return run
    }

    console.log(
      `Mac release build workflow is ${run.status}; polling again in ${options.pollSeconds}s`
    )
    await sleep(options.pollSeconds * 1000)
  }

  throw new Error(
    `Timed out after ${options.timeoutMinutes}m waiting for mac release build workflow ${workflowRunId}.`
  )
}

export function createGitHubApiClient(options, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required.')
  }

  const [owner, repo] = options.repo.split('/')
  if (!owner || !repo) {
    throw new Error(`GITHUB_REPOSITORY must be in owner/repo form, got "${options.repo}".`)
  }

  return {
    owner,
    repo,
    async request(method, path, body) {
      const response = await fetchImpl(`${options.apiBaseUrl}${path}`, {
        body: body == null ? undefined : JSON.stringify(body),
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${options.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': DEFAULT_API_VERSION
        },
        method
      })
      const text = await response.text()
      const data = text.length > 0 ? JSON.parse(text) : null

      if (!response.ok) {
        throw new Error(
          `GitHub API ${method} ${path} failed with ${response.status}: ${formatApiError(data)}`
        )
      }

      return data
    }
  }
}

function readWorkflowRunFromDispatchResult(result) {
  if (Number.isInteger(result?.workflow_run_id)) {
    return {
      html_url: result.html_url,
      id: result.workflow_run_id
    }
  }

  return null
}

function formatApiError(data) {
  if (typeof data?.message === 'string') {
    return data.message
  }

  return JSON.stringify(data)
}

function readPositiveInteger(rawValue, defaultValue) {
  if (rawValue == null || rawValue === '') {
    return defaultValue
  }

  const value = Number(rawValue)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Expected a positive integer, got "${rawValue}".`)
  }

  return value
}

function requiredEnv(value, name) {
  if (value == null || value === '') {
    throw new Error(`${name} is required.`)
  }

  return value
}

function sleepMilliseconds(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runReleaseMacBuildWorkflow(readReleaseMacBuildWorkflowOptions()).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
