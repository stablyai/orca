// Lint what a main push changed with the repo's own oxlint configs, then name the commits and merged PRs behind
// each failure. PR checks lint each PR against an older main, so a merge can still push a file over a limit; this
// reports the failure first, then attributes it. The plan comes from the earlier plan step when it ran.
import { appendFileSync, readFileSync } from 'node:fs'
import process from 'node:process'
import { resolveOxlintInvocation } from '../../tool-invocation/oxlint-cli-invocation.mjs'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'
import { governingPolicies } from './main-push-plan.mjs'
import { git } from './main-push-range.mjs'
import {
  escapeAnnotationData,
  escapeAnnotationProperty,
  logLine,
  countCaveat,
  incompleteHeading,
  logText,
  truncate,
  MAX_LOG_LINE_CHARS,
  renderAttributionSummary,
  renderLintSummary
} from './main-push-report.mjs'
import { createBatchCollector, runOxlint } from './oxlint-batches.mjs'
import { computePlan, rangeText, reportPlanFailure } from './plan-main-push-lint.mjs'
import { attributeFiles, createGithubApi, describeAttribution } from './push-attribution.mjs'

// GitHub shows at most 10 error annotations per step; the log carries the rest.
const MAX_ANNOTATIONS = 20
// Diagnostic lines have their own count cap; every other log line shares one byte budget.
const MAX_LOG_DIAGNOSTICS = 1_000
const LOG_BUDGET_BYTES = 256 * 1024
const MAX_INCOMPLETE_LOGGED = 10
const MAX_LOGGED_PATHS = 50
// Each annotation's text is cut before escaping, so every annotation, and so all of them, have a byte bound.
const MAX_ANNOTATION_CHARS = 2_000
const MAX_ANNOTATION_PATH_CHARS = 500
// A summary cell keeps 500 characters and a log line 1,000; explanations stay under both.
const SUMMARY_CAUSE_BUDGET = 440
const LOG_CAUSE_BUDGET = 800
const MAX_WHY_CHARS = 120
const MAX_COMMIT_CHARS = 150

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
      const text = truncate(String(message), MAX_ANNOTATION_CHARS)
      write(
        `::error ${location}title=${escapeAnnotationProperty(truncate(title, 200))}::${escapeAnnotationData(text)}`
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

export function reportDiagnostics(diagnostics, errorCount, reporter) {
  for (const diagnostic of diagnostics.slice(0, MAX_LOG_DIAGNOSTICS)) {
    reporter.writeEscaped(logLine(diagnostic))
  }
  if (errorCount > MAX_LOG_DIAGNOSTICS) {
    reporter.writeEscaped(
      `${errorCount - MAX_LOG_DIAGNOSTICS} more oxlint error(s) are not listed.`
    )
  }
  for (const diagnostic of diagnostics.slice(0, MAX_ANNOTATIONS)) {
    // A path too long to bound is left out of the location; the log line still names it.
    const location =
      diagnostic.file &&
      !diagnostic.ambiguous &&
      !diagnostic.unverified &&
      diagnostic.file.length <= MAX_ANNOTATION_PATH_CHARS
        ? `file=${escapeAnnotationProperty(diagnostic.file)},line=${diagnostic.line},col=${diagnostic.col},`
        : ''
    const which = diagnostic.ambiguous
      ? ` (oxlint reported ${diagnostic.file}, which could be any of: ${diagnostic.ambiguous.join(', ')})`
      : diagnostic.unverified
        ? ` (oxlint reported ${diagnostic.file}; tracked files could not be read to verify it)`
        : ''
    reporter.error(diagnostic.rule, `${diagnostic.message}${which}`, location)
  }
  return Math.min(diagnostics.length, MAX_LOG_DIAGNOSTICS)
}

// Returns how many groups of unlinted paths are in the log, which the summary then cites.
export function reportIncomplete(incomplete, reporter) {
  let logged = 0
  for (const batch of incomplete.slice(0, MAX_INCOMPLETE_LOGGED)) {
    const output = batch.output.trim().slice(0, 4_000)
    reporter.error(
      'Main-push lint',
      `${incompleteHeading(batch)} (${batch.reason})${output ? `:\n${output}` : '.'}`
    )
    const more =
      batch.files.length > MAX_LOGGED_PATHS
        ? ` and ${batch.files.length - MAX_LOGGED_PATHS} more`
        : ''
    // A run that reported some errors before stopping linted part of its paths.
    // A run that started may have linted some of its paths before it stopped, whatever it printed.
    const label = batch.ran !== false ? 'Not fully linted' : 'Not linted'
    if (reporter.log(`${label}: ${batch.files.slice(0, MAX_LOGGED_PATHS).join(' ')}${more}`)) {
      logged += 1
    }
  }
  if (incomplete.length > MAX_INCOMPLETE_LOGGED) {
    reporter.log(
      `${incomplete.length - MAX_INCOMPLETE_LOGGED} more group(s) of unlinted paths are not listed.`
    )
  }
  return logged
}

// oxlint 1.94 prints a literal backslash in a reported path as a slash. For each printed name that a tracked
// file with a backslash can produce, every tracked file it may stand for (the slash form first, if tracked).
export async function backslashIndex(root) {
  const tracked = (await git(['ls-files', '-z'], root)).split('\0').filter(Boolean)
  const byPrinted = new Map()
  for (const file of tracked.filter((name) => name.includes('\\'))) {
    const printed = file.replaceAll('\\', '/')
    byPrinted.set(printed, [...(byPrinted.get(printed) ?? []), file])
  }
  if (byPrinted.size > 0) {
    const trackedSet = new Set(tracked)
    for (const [printed, files] of byPrinted) {
      if (trackedSet.has(printed)) {
        files.unshift(printed)
      }
    }
  }
  return byPrinted
}

// Map each printed name back to the one tracked file it stands for; when it could be several, keep it, mark it
// ambiguous, and leave the location and attribution out.
export function resolveReportedPaths(diagnostics, index) {
  for (const diagnostic of diagnostics) {
    const candidates = index.get(diagnostic.file)
    if (candidates?.length === 1) {
      diagnostic.file = candidates[0]
    } else if (candidates) {
      diagnostic.ambiguous = candidates
    }
  }
}

// Why an untouched file was linted, within `budget` characters. Every count comes first (policy changes, how
// many have unreadable inputs, how many are shown), so a later cut can only drop detail. Each shown change gives
// its cut cause, how many changed inputs it has, and the commits behind the first; the first change always fits.
export function explainPolicies(policies, describe, noun, budget = SUMMARY_CAUSE_BUDGET) {
  const unreadable = policies.filter((policy) => policy.unreadable?.length > 0).length
  const entry = (policy) => {
    const [first] = policy.paths
    const inputs = `${policy.paths.length} changed input(s)${policy.unreadable?.length > 0 ? ', some unreadable' : ''}`
    const source = first
      ? `${first} changed by ${truncate(describe(first), MAX_COMMIT_CHARS)}`
      : `no changed input in ${noun} can be named: its inputs cannot be read`
    return `${truncate(policy.why, MAX_WHY_CHARS)} [${inputs}] (${source})`
  }
  const counts = (shown) =>
    `${policies.length} lint policy change(s) cover it` +
    `${unreadable > 0 ? `, ${unreadable} with unreadable inputs` : ''}; ${shown} shown: `
  const entries = []
  for (const policy of policies) {
    const used =
      counts(policies.length).length + entries.reduce((total, text) => total + text.length + 2, 0)
    const text = entry(policy)
    if (entries.length > 0 && used + text.length > budget) {
      break
    }
    entries.push(entries.length === 0 ? truncate(text, Math.max(budget - used, 80)) : text)
  }
  return `${counts(entries.length)}${entries.join('; ')}`
}

async function reportAttribution({ diagnostics, plan, env, reporter, api }) {
  const failing = [
    ...new Set(
      diagnostics
        .filter((diagnostic) => !diagnostic.ambiguous && !diagnostic.unverified)
        .map((diagnostic) => diagnostic.file)
        .filter(Boolean)
    )
  ]
  const ambiguous = new Map(
    diagnostics
      .filter((diagnostic) => diagnostic.ambiguous)
      .map((diagnostic) => [diagnostic.file, diagnostic.ambiguous])
  )
  // Without the tracked-path index, a printed path may not be the tracked file: no lookup is made for it.
  const unverified = [
    ...new Set(
      diagnostics.filter((diagnostic) => diagnostic.unverified).map((diagnostic) => diagnostic.file)
    )
  ]
  if (failing.length === 0 && ambiguous.size === 0 && unverified.length === 0) {
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
      ...[...policiesFor.values()].flat().flatMap((policy) => policy.paths)
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
  // The summary cell and the log line each get an explanation sized for them.
  const becauseOf = (file, budget) =>
    `not changed in ${noun}; linted because ${explainPolicies(policiesFor.get(file), describe, noun, budget)}`
  const unattributed = (description) => ({
    description,
    logDescription: description,
    unclear: true
  })
  const rows = [
    ...failing.map((file) =>
      touched.has(file)
        ? { file, description: describe(file), logDescription: describe(file) }
        : {
            file,
            description: becauseOf(file, SUMMARY_CAUSE_BUDGET),
            logDescription: becauseOf(file, LOG_CAUSE_BUDGET),
            policyRow: true
          }
    ),
    ...[...ambiguous].map(([file, candidates]) => ({
      file,
      ...unattributed(
        `not attributed: oxlint reported this path, which could be any of ${candidates.join(', ')}`
      )
    })),
    ...unverified.map((file) => ({
      file,
      ...unattributed(
        'not attributed: tracked files could not be read, so this printed path is unverified'
      )
    }))
  ]
  let logged = 0
  for (const { file, logDescription, unclear, policyRow } of rows) {
    const line =
      touched.has(file) && !unclear && !policyRow
        ? `${file}: changed in ${noun} by ${logDescription}`
        : `${file}: ${logDescription}`
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
  const walked = plan.dirs.length > 0 ? `, every file under ${plan.dirs.join(', ')}` : ''
  reporter.log(
    `Linting ${plan.touched.length} changed candidate file(s) (${plan.files.length} named explicitly)${walked} in ${range}: ${plan.scope}.`
  )
  for (const policy of plan.policies) {
    reporter.log(`Lint policy changed: ${policy.why}; linting everything under ${policy.dir}.`)
  }
  // The tracked-path index is best effort; without it no repeat is dropped, and the count says so.
  let index = new Map()
  let indexError = null
  try {
    index = await backslashIndex(root)
  } catch (error) {
    indexError = error
  }
  const collector = createBatchCollector(
    {},
    {
      overlap: plan.overlap ?? [],
      uncertain: new Set(
        [...index].filter(([, files]) => files.length > 1).map(([printed]) => printed)
      ),
      uncertainAll: Boolean(indexError)
    }
  )
  let results = collector.result()
  if (targets.length > 0) {
    try {
      const invocation = resolveOxlintInvocation(invocationRoot)
      // Each child's output is digested as it ends, so earlier results survive a later stall.
      await runOxlint(targets, { cwd: root, invocation, onResult: collector.add })
      results = collector.result()
    } catch (error) {
      results = collector.result()
      results.incomplete.push({
        files: targets,
        ran: false,
        reason: 'could not run oxlint',
        output: `${error.message}\n`
      })
    }
  }
  if (plan.unrepresentable.length > 0) {
    results.incomplete.push({
      files: plan.unrepresentable,
      ran: false,
      reason: 'the path is not valid UTF-8, so it cannot be passed to oxlint exactly',
      output: ''
    })
  }
  const { diagnostics, errorCount, incomplete, linted } = results
  // Mapping printed paths back to tracked files is best effort; a failure must not cost the verdict.
  if (indexError) {
    for (const diagnostic of diagnostics) {
      diagnostic.unverified = Boolean(diagnostic.file)
    }
    reporter.log(
      `Could not map reported paths to tracked files (${truncate(String(indexError.message), 300)}); paths are shown as oxlint printed them.`
    )
  } else {
    resolveReportedPaths(diagnostics, index)
  }
  // The verdict, locations and summary are published before any optional PR lookup.
  const loggedDiagnostics = reportDiagnostics(diagnostics, errorCount, reporter)
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
      errorCount,
      incomplete,
      loggedDiagnostics,
      loggedIncomplete,
      overlap: plan.overlap ?? [],
      repeatsUncertain: results.repeatsUncertain
    })
  )
  reporter.log(
    `oxlint reported linting ${linted} file(s); ${plan.touched.length} changed candidate file(s)${countCaveat({ overlap: plan.overlap ?? [], repeatsUncertain: results.repeatsUncertain })}.`
  )
  await reportAttribution({ diagnostics, plan, env, reporter, api })
  reporter.finish()
  return errorCount > 0 || incomplete.length > 0 ? 1 : 0
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await main()
}
