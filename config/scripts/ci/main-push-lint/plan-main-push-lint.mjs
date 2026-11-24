// Plan a main-push lint before any dependency setup: a push that changes no lintable file and no lint policy
// skips the install and oxlint entirely. Uses only Node built-ins and Git, so it runs on the bare runner.
import { appendFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'
import { isEmptyPlan, planLint } from './main-push-plan.mjs'
import { git, resolveRange } from './main-push-range.mjs'
import { escapeAnnotationData, logText, markdownCode, markdownText } from './main-push-report.mjs'

export async function computePlan({ env, root }) {
  const head = (await git(['rev-parse', env.HEAD_SHA || 'HEAD'], root)).trim()
  const event = env.GITHUB_EVENT_NAME || 'workflow_dispatch'
  const { base, scope } = await resolveRange({ event, before: env.BEFORE_SHA, head, cwd: root })
  return { event, base, head, scope, ...(await planLint({ base, head, cwd: root })) }
}

export function rangeText(plan) {
  return `${plan.base.slice(0, 10)}..${plan.head.slice(0, 10)}`
}

export function appendSummary(env, markdown) {
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
  }
}

// An unusable range fails the run with the reason in an annotation and the summary.
export function reportPlanFailure(env, error) {
  process.stdout.write(`::error title=Main-push lint::${escapeAnnotationData(error.message)}\n`)
  appendSummary(env, `### Main-push lint failed\n\n${markdownText(error.message)}`)
}

export async function main({ env = process.env, root = process.cwd() } = {}) {
  let plan
  try {
    plan = await computePlan({ env, root })
  } catch (error) {
    reportPlanFailure(env, error)
    return 1
  }
  const lint = !isEmptyPlan(plan)
  if (env.MAIN_PUSH_LINT_PLAN) {
    writeFileSync(env.MAIN_PUSH_LINT_PLAN, JSON.stringify(plan))
  }
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `lint=${lint}\n`)
  }
  process.stdout.write(
    `${logText(
      `Plan for ${rangeText(plan)} (${plan.scope}): ${plan.touched.length} changed lintable file(s), ${plan.files.length} of them named explicitly, ` +
        `${plan.dirs.length} director(ies) to walk for a lint policy change, ${plan.unrepresentable.length} non-UTF-8 path(s).`
    )}\n`
  )
  if (!lint) {
    appendSummary(
      env,
      `### Main-push lint passed\n\nRange ${markdownCode(rangeText(plan))}: ${plan.scope}. Nothing to lint: no lintable file and no lint policy changed, so dependency setup and oxlint were skipped.\n`
    )
  }
  return 0
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await main()
}
