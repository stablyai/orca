import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DEFAULT_API_VERSION = '2026-03-10'
const DEFAULT_TIMEOUT_MINUTES = 90
const DEFAULT_POLL_SECONDS = 30
const RUN_DISCOVERY_TIMEOUT_SECONDS = 120

export function readReleaseMacBuildWorkflowOptions(env = process.env) {
  return {
    apiBaseUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
    pollSeconds: readPositiveInteger(env.RELEASE_MAC_BUILD_POLL_SECONDS, DEFAULT_POLL_SECONDS),
    ref: requiredEnv(env.RELEASE_MAC_BUILD_REF, 'RELEASE_MAC_BUILD_REF'),
    javascriptSourceSha: env.RELEASE_MAC_BUILD_JAVASCRIPT_SOURCE_SHA || undefined,
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
  const workflowRun = await startReleaseMacBuildWorkflow(options, deps)
  return await finishReleaseMacBuildWorkflow(options, workflowRun.id, deps)
}

export async function startReleaseMacBuildWorkflow(options, deps = {}) {
  const api = createGitHubApiClient(options, deps)
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? sleepMilliseconds
  const dispatchStartedAtMs = now() - 10_000
  const dispatchResult = await dispatchReleaseMacBuildWorkflow(api, options)
  const directRun = readWorkflowRunFromDispatchResult(dispatchResult)
  // The pinned API returns its run ID; a title match cannot identify the POST.
  if (deps.requireDirectRunId && !directRun) {
    throw new Error(
      'GitHub dispatch did not return its workflow run ID; refusing ambiguous discovery.'
    )
  }
  const workflowRun =
    directRun ??
    (await findDispatchedReleaseMacBuildRun(api, options, {
      dispatchStartedAtMs,
      now,
      sleep
    }))

  console.log(`Dispatched mac release build workflow ${workflowRun.id}: ${workflowRun.html_url}`)
  return workflowRun
}

export function assertReleaseMacBuildRunIdentity(run, options, expected) {
  if (
    String(run.id) !== String(expected.id) ||
    run.event !== 'workflow_dispatch' ||
    run.path !== `.github/workflows/${options.workflow}` ||
    run.display_title !== expectedReleaseMacBuildRunTitle(options) ||
    run.head_branch !== options.ref ||
    !/^[a-f0-9]{40}$/.test(run.head_sha ?? '') ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0 ||
    (expected.headSha && run.head_sha !== expected.headSha) ||
    (expected.attempt && run.run_attempt !== expected.attempt)
  ) {
    throw new Error(`Mac release build run ${expected.id} does not match the dispatched workflow.`)
  }
  return run
}

async function readDispatchedReleaseMacBuildRun(api, options, runId, deps) {
  const sleep = deps.sleep ?? sleepMilliseconds
  for (let attempt = 0; ; attempt += 1) {
    const run = await api.request('GET', `/repos/${api.owner}/${api.repo}/actions/runs/${runId}`)
    try {
      return assertReleaseMacBuildRunIdentity(run, options, { id: runId })
    } catch (error) {
      if (attempt >= 6) {
        throw error
      }
      // GitHub can return incomplete metadata immediately after dispatch.
      console.log(`Waiting for dispatched mac release build ${runId} metadata to settle.`)
      await sleep(5_000)
    }
  }
}

export async function finishReleaseMacBuildWorkflow(options, workflowRunId, deps = {}) {
  const api = createGitHubApiClient(options, deps)
  const completedRun = await waitForReleaseMacBuildRun(api, workflowRunId, options, deps)

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
      tag: options.tag,
      ...(options.javascriptSourceSha ? { javascript_source_sha: options.javascriptSourceSha } : {})
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
  const deadlineMs = deps.deadlineMs ?? now() + options.timeoutMinutes * 60 * 1000

  let firstObservation = true
  while (now() <= deadlineMs || (firstObservation && deps.deadlineMs != null)) {
    firstObservation = false
    const run = await api.request(
      'GET',
      `/repos/${api.owner}/${api.repo}/actions/runs/${workflowRunId}`
    )

    if (deps.expectedIdentity) {
      assertReleaseMacBuildRunIdentity(run, options, deps.expectedIdentity)
    }
    if (run.status === 'completed') {
      if (deps.deadlineMs != null) {
        const completedAtMs = Date.parse(run.updated_at ?? '')
        if (!Number.isFinite(completedAtMs) || completedAtMs > deadlineMs) {
          throw new Error(
            `Mac release build workflow ${workflowRunId} exceeded its original deadline.`
          )
        }
      }
      return run
    }
    if (now() > deadlineMs) {
      break
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
  if (Number.isSafeInteger(result?.workflow_run_id) && result.workflow_run_id > 0) {
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

export async function executeReleaseMacBuildMode(mode, env = process.env, deps = {}) {
  const options = readReleaseMacBuildWorkflowOptions(env)
  if (mode == null) {
    return await runReleaseMacBuildWorkflow(options, deps)
  }
  if (mode === 'dispatch') {
    const output = requiredEnv(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT')
    const dispatched = await startReleaseMacBuildWorkflow(options, {
      ...deps,
      requireDirectRunId: true
    })
    const api = createGitHubApiClient(options, deps)
    const run = await readDispatchedReleaseMacBuildRun(api, options, dispatched.id, deps)
    const now = deps.now ?? Date.now
    const deadlineMs = now() + options.timeoutMinutes * 60 * 1000
    const appendOutput = deps.appendOutput ?? appendFileSync
    appendOutput(
      output,
      `run_id=${run.id}\nworkflow_sha=${run.head_sha}\nrun_attempt=${run.run_attempt}\nwait_deadline_ms=${deadlineMs}\n`
    )
    return run
  }
  if (mode === 'wait') {
    const runId = requiredEnv(env.RELEASE_MAC_BUILD_RUN_ID, 'RELEASE_MAC_BUILD_RUN_ID')
    if (!/^[1-9][0-9]*$/.test(runId)) {
      throw new Error('RELEASE_MAC_BUILD_RUN_ID must be a positive integer.')
    }
    const headSha = requiredEnv(
      env.RELEASE_MAC_BUILD_WORKFLOW_SHA,
      'RELEASE_MAC_BUILD_WORKFLOW_SHA'
    )
    if (!/^[a-f0-9]{40}$/.test(headSha)) {
      throw new Error('RELEASE_MAC_BUILD_WORKFLOW_SHA must be a commit SHA.')
    }
    const attempt = Number(
      requiredEnv(env.RELEASE_MAC_BUILD_RUN_ATTEMPT, 'RELEASE_MAC_BUILD_RUN_ATTEMPT')
    )
    if (!Number.isSafeInteger(attempt) || attempt <= 0) {
      throw new Error('RELEASE_MAC_BUILD_RUN_ATTEMPT must be a positive integer.')
    }
    const deadlineMs = Number(
      requiredEnv(env.RELEASE_MAC_BUILD_WAIT_DEADLINE_MS, 'RELEASE_MAC_BUILD_WAIT_DEADLINE_MS')
    )
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) {
      throw new Error('RELEASE_MAC_BUILD_WAIT_DEADLINE_MS must be a positive timestamp.')
    }
    return await finishReleaseMacBuildWorkflow(options, runId, {
      ...deps,
      deadlineMs,
      expectedIdentity: { id: runId, headSha, attempt }
    })
  }
  throw new Error(`Unknown mac release build mode: ${mode}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executeReleaseMacBuildMode(process.argv[2]).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
