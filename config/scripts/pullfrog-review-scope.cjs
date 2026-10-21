function reviewNumber(inputs) {
  if (/^[1-9]\d*$/.test(inputs.pull_request_number ?? '')) {
    return Number(inputs.pull_request_number)
  }
  const match =
    / \| PR ([1-9]\d*)$/.exec(inputs.name ?? '') ??
    /^Review (?:new commits on )?#([1-9]\d*) \[[\w-]+\]$/.exec(inputs.name ?? '')
  return match ? Number(match[1]) : null
}

function reviewRunOrder(runs, number, runId) {
  const related = runs.filter((run) => reviewNumber({ name: run.display_title }) === number)
  return {
    superseded: related.some((run) => run.id > runId),
    older: related
      .filter(
        (run) =>
          run.id < runId &&
          ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)
      )
      .map((run) => run.id)
  }
}

async function reviewScope({ github, context, core }) {
  const inputs = context.payload.inputs ?? {}
  const number = reviewNumber(inputs)
  core.setOutput('current', 'true')
  if (!number || !Number.isSafeInteger(number)) {
    return
  }
  try {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number })
    if (pr.state !== 'open' || (inputs.head_sha && inputs.head_sha !== pr.head.sha)) {
      core.setOutput('current', 'false')
      return
    }
    core.setOutput('head', pr.head.sha)
    core.setOutput('number', String(number))
    const { data } = await github.rest.actions.listWorkflowRuns({
      ...context.repo,
      workflow_id: 'pullfrog.yml',
      event: 'workflow_dispatch',
      per_page: 100
    })
    const order = reviewRunOrder(data.workflow_runs, number, context.runId)
    if (order.superseded) {
      core.setOutput('current', 'false')
      return
    }
    // Run IDs, unlike scope-job completion order, cannot let an older review cancel a newer one.
    for (const runId of order.older) {
      try {
        await github.rest.actions.cancelWorkflowRun({ ...context.repo, run_id: runId })
      } catch (error) {
        core.warning(`Could not cancel older review ${runId}: ${error.message}`)
      }
    }
  } catch (error) {
    core.warning(`Review identity unavailable; leaving this task independent: ${error.message}`)
  }
}

module.exports = { reviewNumber, reviewRunOrder, reviewScope }
