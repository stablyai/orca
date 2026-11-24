// Lint what a main push changed with the repo's own oxlint configs, then name the commits and merged PRs behind
// each failure. PR checks lint each PR against an older main, so a merge can still push a file over a limit; this
// reports the failure first, then attributes it. The plan comes from the earlier plan step when it ran.
import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { resolveOxlintInvocation } from '../../tool-invocation/oxlint-cli-invocation.mjs'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'
import { governingPolicies } from './main-push-plan.mjs'
import {
  escapeAnnotationData,
  escapeAnnotationProperty,
  logLine,
  logText,
  MAX_LOG_LINE_CHARS,
  renderAttributionSummary,
  renderLintSummary
} from './main-push-report.mjs'
import { collectBatchResults, runOxlint } from './oxlint-batches.mjs'
import { computePlan, rangeText, reportPlanFailure } from './plan-main-push-lint.mjs'
import { attributeFiles, createGithubApi, describeAttribution } from './push-attribution.mjs'

// GitHub shows at most 10 error annotations per step; the log carries the rest.
const MAX_ANNOTATIONS = 20
// Diagnostic lines have their own count cap; every other log line shares one byte budget.
const MAX_LOG_DIAGNOSTICS = 1_000
const LOG_BUDGET_BYTES = 256 * 1024
const MAX_INCOMPLETE_LOGGED = 10
const MAX_LOGGED_PATHS = 50

export function createReporter(env) {
  let logBytes = 0
  let omittedLines = 0
  let omittedAnnotations = 0
  let annotations = 0
  const write = (line) => process.stdout.write(`${line}\n`)
  return {
    // Escapes and truncates the line; returns whether it fit in the log budget.
    log(text) {
      const line = logText(text, MAX_LOG_LINE_CHARS)
      logBytes += Buffer.byteLength(line) + 1
      if (logBytes > LOG_BUDGET_BYTES) {
        omittedLines += 1
        return false
      }
      write(line)
      return true
    },
    // A line already escaped for the log, outside the shared budget (diagnostics have their own count cap).
    writeEscaped: write,
    error(title, message, location = '') {
      annotations += 1
      if (annotations > MAX_ANNOTATIONS + MAX_INCOMPLETE_LOGGED + 1) {
        omittedAnnotations += 1
        return
      }
      write(
        `::error ${location}title=${escapeAnnotationProperty(title)}::${escapeAnnotationData(message)}`
      )
    },
    summary(markdown) {
      if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
      }
    },
    finish() {
      if (omittedLines > 0) {
        write(
          `${omittedLines} more log line(s) were omitted after the ${LOG_BUDGET_BYTES / 1024} KiB log budget.`
        )
      }
      if (omittedAnnotations > 0) {
        write(`${omittedAnnotations} more error annotation(s) were omitted.`)
      }
    }
  }
}

function reportDiagnostics(diagnostics, reporter) {
  for (const diagnostic of diagnostics.slice(0, MAX_LOG_DIAGNOSTICS)) {
    reporter.writeEscaped(logLine(diagnostic))
  }
  if (diagnostics.length > MAX_LOG_DIAGNOSTICS) {
    reporter.writeEscaped(
      `${diagnostics.length - MAX_LOG_DIAGNOSTICS} more oxlint error(s) are not listed.`
    )
  }
  for (const diagnostic of diagnostics.slice(0, MAX_ANNOTATIONS)) {
    const location = diagnostic.file
      ? `file=${escapeAnnotationProperty(diagnostic.file)},line=${diagnostic.line},col=${diagnostic.col},`
      : ''
    reporter.error(diagnostic.rule, diagnostic.message, location)
  }
  return Math.min(diagnostics.length, MAX_LOG_DIAGNOSTICS)
}

function reportIncomplete(incomplete, reporter) {
  for (const batch of incomplete.slice(0, MAX_INCOMPLETE_LOGGED)) {
    const output = batch.output.trim().slice(0, 4_000)
    reporter.error(
      'Main-push lint',
      `oxlint did not finish ${batch.files.length} path(s) (${batch.reason}), so they were not linted:\n${output}`
    )
    const more =
      batch.files.length > MAX_LOGGED_PATHS
        ? ` and ${batch.files.length - MAX_LOGGED_PATHS} more`
        : ''
    reporter.log(`Not linted: ${batch.files.slice(0, MAX_LOGGED_PATHS).join(' ')}${more}`)
  }
  if (incomplete.length > MAX_INCOMPLETE_LOGGED) {
    reporter.log(
      `${incomplete.length - MAX_INCOMPLETE_LOGGED} more unfinished oxlint run(s) are not listed.`
    )
  }
  return Math.min(incomplete.length, MAX_INCOMPLETE_LOGGED)
}

// A failing file the push touched is attributed to the commits that changed it. One it did not touch was
// linted only because a lint policy changed, so the commits that changed that policy are named instead.
async function reportAttribution({ diagnostics, plan, env, reporter, api }) {
  const failing = [...new Set(diagnostics.map((diagnostic) => diagnostic.file).filter(Boolean))]
  if (failing.length === 0) {
    return
  }
  const ref = env.GITHUB_REF_NAME || 'main'
  const noun = plan.event === 'push' ? 'this push' : 'the linted range'
  const touched = new Set(plan.touched)
  const policiesFor = new Map(
    failing
      .filter((file) => !touched.has(file))
      .map((file) => [file, governingPolicies(file, plan.policies)])
  )
  const lookups = [
    ...new Set([
      ...failing.filter((file) => touched.has(file)),
      ...[...policiesFor.values()].flat().map((policy) => policy.path)
    ])
  ]
  const attributions = env.GITHUB_REPOSITORY
    ? await attributeFiles(lookups, {
        base: plan.base,
        head: plan.head,
        repo: env.GITHUB_REPOSITORY,
        ref,
        api: api ?? createGithubApi(env)
      })
    : new Map()
  const describe = (file) => describeAttribution(attributions.get(file), ref)
  const rows = failing.map((file) => ({
    file,
    description: touched.has(file)
      ? describe(file)
      : `not changed in ${noun}; linted because ${policiesFor
          .get(file)
          .map(
            (policy) => `${policy.why}, and ${policy.path} was changed by ${describe(policy.path)}`
          )
          .join('; ')}`
  }))
  let logged = 0
  for (const { file, description } of rows) {
    const line = touched.has(file)
      ? `${file}: changed in ${noun} by ${description}`
      : `${file}: ${description}`
    if (reporter.log(line)) {
      logged += 1
    }
  }
  reporter.summary(renderAttributionSummary(rows, { noun, logged }))
}

function readPlan(env, root) {
  if (env.MAIN_PUSH_LINT_PLAN) {
    return JSON.parse(readFileSync(env.MAIN_PUSH_LINT_PLAN, 'utf8'))
  }
  return computePlan({ env, root })
}

export async function main({
  env = process.env,
  root = process.cwd(),
  invocationRoot = root,
  api
} = {}) {
  const reporter = createReporter(env)
  let plan
  try {
    plan = await readPlan(env, root)
  } catch (error) {
    reportPlanFailure(env, error)
    return 1
  }
  const range = rangeText(plan)
  const targets = [...plan.dirs, ...plan.files]
  reporter.log(
    `Linting ${plan.touched.length} changed candidate file(s)${plan.dirs.length > 0 ? ` and every file under ${plan.dirs.join(', ')}` : ''} in ${range}: ${plan.scope}.`
  )
  for (const policy of plan.policies) {
    reporter.log(`Lint policy changed: ${policy.why}; linting everything under ${policy.dir}.`)
  }
  let results = { diagnostics: [], incomplete: [], linted: 0 }
  if (targets.length > 0) {
    try {
      const invocation = resolveOxlintInvocation(invocationRoot)
      results = collectBatchResults(await runOxlint(targets, { cwd: root, invocation }))
    } catch (error) {
      results.incomplete.push({
        files: targets,
        reason: 'could not run oxlint',
        output: `${error.message}\n`
      })
    }
  }
  if (plan.unrepresentable.length > 0) {
    results.incomplete.push({
      files: plan.unrepresentable,
      reason: 'the path is not valid UTF-8, so it cannot be passed to oxlint exactly',
      output: ''
    })
  }
  const { diagnostics, incomplete, linted } = results
  // The verdict, locations and summary are published before any optional PR lookup.
  const loggedDiagnostics = reportDiagnostics(diagnostics, reporter)
  const loggedIncomplete = reportIncomplete(incomplete, reporter)
  reporter.summary(
    renderLintSummary({
      range,
      scope: plan.scope,
      candidates: plan.touched.length,
      dirs: plan.dirs,
      policies: plan.policies,
      linted,
      diagnostics,
      incomplete,
      loggedDiagnostics,
      loggedIncomplete
    })
  )
  reporter.log(
    `oxlint reported linting ${linted} file(s); ${plan.touched.length} changed candidate file(s).`
  )
  await reportAttribution({ diagnostics, plan, env, reporter, api })
  reporter.finish()
  return diagnostics.length > 0 || incomplete.length > 0 ? 1 : 0
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await main()
}
