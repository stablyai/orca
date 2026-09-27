import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export function prCheckRunTitle({ number, sourceSha, workflowSha }) {
  return `PR ${number} | source ${sourceSha} | workflow ${workflowSha}`
}

export function reusablePrCheckRun(runs, identity) {
  if (
    !Number.isSafeInteger(identity.number) ||
    identity.number < 1 ||
    ![identity.sourceSha, identity.workflowSha, identity.headSha].every((sha) =>
      /^[a-f0-9]{40}$/.test(sha ?? '')
    )
  ) {
    return undefined
  }
  return runs.find(
    (run) =>
      Number.isSafeInteger(run.id) &&
      run.id > 0 &&
      String(run.id) !== identity.runId &&
      run.path === '.github/workflows/pr.yml' &&
      run.event === 'pull_request' &&
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.head_sha === identity.headSha &&
      run.display_title === prCheckRunTitle(identity)
  )
}

export async function lookupReadyCheckRun(env, event, request = fetch) {
  if (
    env.GITHUB_EVENT_NAME !== 'pull_request' ||
    event.action !== 'ready_for_review' ||
    event.pull_request?.draft !== false
  ) {
    return undefined
  }
  const identity = {
    number: event.pull_request?.number,
    headSha: event.pull_request?.head?.sha,
    sourceSha: env.GITHUB_SHA,
    workflowSha: env.PR_CHECK_WORKFLOW_SHA,
    runId: env.GITHUB_RUN_ID
  }
  const repository = env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !env.GH_TOKEN) {
    return undefined
  }
  const url = new URL(
    `/repos/${repository}/actions/workflows/pr.yml/runs`,
    env.GITHUB_API_URL ?? 'https://api.github.com'
  )
  url.search = new URLSearchParams({
    event: 'pull_request',
    head_sha: identity.headSha ?? '',
    status: 'success',
    per_page: '20'
  }).toString()
  try {
    const response = await request(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GH_TOKEN}`,
        'User-Agent': 'orca-pr-ready-check-reuse',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) {
      throw new Error(`Run lookup returned HTTP ${response.status}`)
    }
    const result = await response.json()
    if (!Array.isArray(result.workflow_runs)) {
      throw new Error('Run lookup omitted workflow runs')
    }
    return reusablePrCheckRun(result.workflow_runs, identity)
  } catch (error) {
    console.log(`No reusable result: ${error.message}; running the required checks.`)
    return undefined
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let run
  try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
    run = await lookupReadyCheckRun(process.env, event)
  } catch (error) {
    console.log(`No reusable result: ${error.message}; running the required checks.`)
  }
  appendFileSync(process.env.GITHUB_OUTPUT, `reused=${Boolean(run)}\nrun_id=${run?.id ?? ''}\n`)
  console.log(
    run
      ? `Required checks already passed for this source and workflow: ${run.html_url}`
      : 'No identical successful run found; running the required checks.'
  )
}
