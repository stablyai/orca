import process from 'node:process'
import { pathToFileURL } from 'node:url'

// Posts to Slack only when main's PR Checks turn red or recover, so a burst of broken merges sends one alert.

const RED = new Set(['failure', 'timed_out', 'startup_failure'])
const GREEN = new Set(['success'])
const MAX_LISTED_JOBS = 10

export function health(conclusion) {
  if (RED.has(conclusion)) {
    return 'red'
  }
  return GREEN.has(conclusion) ? 'green' : undefined
}

/**
 * Decides what the completed run `current` reports, given main push runs of the same workflow.
 * Only the newest settled run speaks, so a slower older run cannot reopen a state a newer one reported.
 * A re-run compares with its own earlier attempt, so a flaky red that passes on retry still recovers.
 */
export function decideTransition(current, runs, previousAttempt = undefined) {
  const now = health(current.conclusion)
  if (!now) {
    return { action: 'none', reason: `Run concluded ${current.conclusion}; health is unchanged.` }
  }
  const settled = runs
    .filter((run) => run.id !== current.id && run.status === 'completed' && health(run.conclusion))
    .sort((left, right) => right.run_number - left.run_number)
  const newer = settled.find((run) => run.run_number > current.run_number)
  if (newer) {
    return {
      action: 'none',
      reason: `Newer run #${newer.run_number} already reported main's health.`
    }
  }
  const previous = settled.find((run) => run.run_number < current.run_number)
  // With no history, assume main was green so the first failure is still announced.
  const before =
    health(previousAttempt?.conclusion) ?? (previous ? health(previous.conclusion) : 'green')
  if (before === now) {
    return { action: 'none', reason: `Main stays ${now}.` }
  }
  return { action: now === 'red' ? 'broken' : 'recovered', previous }
}

export function parseSlackUserIds(json) {
  if (!json?.trim()) {
    return {}
  }
  const parsed = JSON.parse(json)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('SLACK_USER_IDS must be a JSON object of GitHub login to Slack member ID.')
  }
  return parsed
}

// Without a Slack member ID, fall back to the GitHub profile link the release pings use.
export function mention(login, slackUserIds) {
  const id = slackUserIds[login] ?? slackUserIds[login.toLowerCase()]
  return /^[UW][A-Z0-9]+$/.test(id ?? '') ? `<@${id}>` : `<https://github.com/${login}|@${login}>`
}

function escapeMrkdwn(text) {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

export function buildMessage({ action, run, pullRequest, failedJobs, slackUserIds, repoUrl }) {
  const sha = run.head_sha
  const commit = `<${repoUrl}/commit/${sha}|\`${sha.slice(0, 12)}\`>`
  const title = escapeMrkdwn(run.head_commit?.message?.split('\n')[0] ?? '')
  const change = pullRequest
    ? `<${pullRequest.html_url}|#${pullRequest.number} ${escapeMrkdwn(pullRequest.title)}>`
    : title
  const runLink = `<${run.html_url}|Open the run>`
  if (action === 'recovered') {
    return `:white_check_mark: main is green again at ${commit} (${change}). ${runLink}`
  }
  const logins = [
    ...new Set(
      [pullRequest?.merged_by?.login, pullRequest?.user?.login, run.actor?.login].filter(Boolean)
    )
  ].slice(0, 2)
  const people = logins.map((login) => mention(login, slackUserIds)).join(' ')
  const jobs = failedJobs.slice(0, MAX_LISTED_JOBS).map((name) => `• ${escapeMrkdwn(name)}`)
  if (failedJobs.length > MAX_LISTED_JOBS) {
    jobs.push(`• …and ${failedJobs.length - MAX_LISTED_JOBS} more`)
  }
  return [
    `:rotating_light: main is red after ${commit} (${change})${people ? ` ${people}` : ''}`,
    jobs.length > 0 ? `Failed jobs:\n${jobs.join('\n')}` : 'No failed job was reported.',
    runLink
  ].join('\n')
}

export function slackPayload(message) {
  return { text: message, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: message } }] }
}

function githubClient(env, request) {
  const api = env.GITHUB_API_URL ?? 'https://api.github.com'
  return async (route) => {
    const response = await request(`${api}${route}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GH_TOKEN}`,
        'User-Agent': 'orca-main-health-alert',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      throw new Error(`GitHub ${route} returned HTTP ${response.status}`)
    }
    return response.json()
  }
}

export async function main(env = process.env, { request = fetch, log = console.log } = {}) {
  const repository = env.GITHUB_REPOSITORY
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(env.RUN_ID ?? '')) {
    throw new Error('GITHUB_REPOSITORY and RUN_ID are required.')
  }
  const github = githubClient(env, request)
  const run = await github(`/repos/${repository}/actions/runs/${env.RUN_ID}`)
  if (run.event !== 'push' || run.head_branch !== 'main') {
    log(`Run ${run.id} is not a main push; nothing to report.`)
    return undefined
  }
  const { workflow_runs: runs } = await github(
    `/repos/${repository}/actions/workflows/${run.workflow_id}/runs?branch=main&event=push&status=completed&per_page=100`
  )
  const previousAttempt =
    run.run_attempt > 1
      ? await github(`/repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt - 1}`)
      : undefined
  const decision = decideTransition(run, runs, previousAttempt)
  if (decision.action === 'none') {
    log(decision.reason)
    return undefined
  }
  const pulls = await github(`/repos/${repository}/commits/${run.head_sha}/pulls`)
  const merged = pulls.find((pull) => pull.merged_at) ?? pulls[0]
  const pullRequest = merged
    ? await github(`/repos/${repository}/pulls/${merged.number}`)
    : undefined
  const { jobs } = await github(
    `/repos/${repository}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`
  )
  const failedJobs = jobs.filter((job) => RED.has(job.conclusion)).map((job) => job.name)
  const message = buildMessage({
    action: decision.action,
    run,
    pullRequest,
    failedJobs,
    slackUserIds: parseSlackUserIds(env.SLACK_USER_IDS),
    repoUrl: `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}`
  })
  const payload = slackPayload(message)
  if (env.DRY_RUN === '1' || !env.SLACK_WEBHOOK_URL) {
    log(`Dry run (${env.SLACK_WEBHOOK_URL ? 'DRY_RUN=1' : 'no SLACK_WEBHOOK_URL'}); payload:`)
    log(JSON.stringify(payload, null, 2))
    return payload
  }
  const response = await request(env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`Slack webhook returned HTTP ${response.status}`)
  }
  log(`Posted the main ${decision.action} alert.`)
  return payload
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
