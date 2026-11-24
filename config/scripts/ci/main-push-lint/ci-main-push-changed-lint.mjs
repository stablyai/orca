// Lint the files a main push changed with the root oxlint config.
// PR checks lint each PR against an older main, so a merge can still push a file over a limit; this reports
// the failure first, then names the commits and merged PRs in the push that changed each failing file.
import { appendFileSync } from 'node:fs'
import process from 'node:process'
import { resolveOxlintInvocation } from '../../tool-invocation/oxlint-cli-invocation.mjs'
import { isDirectInvocation } from '../../tool-invocation/script-entry-detection.mjs'
import { changedLintableFiles, git, resolveRange } from './main-push-range.mjs'
import {
  escapeAnnotationData,
  escapeAnnotationProperty,
  logLine,
  markdownText,
  renderAttributionSummary,
  renderLintSummary,
  visibleText
} from './main-push-report.mjs'
import { collectBatchResults, runOxlint } from './oxlint-batches.mjs'
import { attributeFiles, createGithubApi, describeAttribution } from './push-attribution.mjs'

// GitHub shows at most 10 error annotations per step; the log carries the rest.
const MAX_ANNOTATIONS = 20
const MAX_LOG_DIAGNOSTICS = 2_000
const MAX_LOGGED_PATHS = 50

function createReporter(env) {
  return {
    log: (line) => process.stdout.write(`${line}\n`),
    error: (title, message, location = '') =>
      process.stdout.write(
        `::error ${location}title=${escapeAnnotationProperty(title)}::${escapeAnnotationData(message)}\n`
      ),
    summary: (markdown) => {
      if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`)
      }
    }
  }
}

function reportDiagnostics(diagnostics, reporter) {
  for (const diagnostic of diagnostics.slice(0, MAX_LOG_DIAGNOSTICS)) {
    reporter.log(logLine(diagnostic))
  }
  if (diagnostics.length > MAX_LOG_DIAGNOSTICS) {
    reporter.log(`${diagnostics.length - MAX_LOG_DIAGNOSTICS} more oxlint error(s) are not listed.`)
  }
  for (const diagnostic of diagnostics.slice(0, MAX_ANNOTATIONS)) {
    const location = diagnostic.file
      ? `file=${escapeAnnotationProperty(diagnostic.file)},line=${diagnostic.line},col=${diagnostic.col},`
      : ''
    reporter.error(diagnostic.rule, diagnostic.message, location)
  }
}

function reportIncomplete(incomplete, reporter) {
  for (const batch of incomplete) {
    const output = batch.output.trim().slice(0, 4_000)
    reporter.error(
      'Main-push lint',
      `oxlint did not finish ${batch.files.length} file(s), so they were not linted:\n${output}`
    )
    const more =
      batch.files.length > MAX_LOGGED_PATHS
        ? ` and ${batch.files.length - MAX_LOGGED_PATHS} more`
        : ''
    reporter.log(
      `Not linted: ${batch.files.slice(0, MAX_LOGGED_PATHS).map(visibleText).join(' ')}${more}`
    )
  }
}

async function reportAttribution({ diagnostics, base, head, env, reporter, api }) {
  const files = [...new Set(diagnostics.map((diagnostic) => diagnostic.file).filter(Boolean))]
  if (files.length === 0) {
    return
  }
  const ref = env.GITHUB_REF_NAME || 'main'
  const attributions = env.GITHUB_REPOSITORY
    ? await attributeFiles(files, {
        base,
        head,
        repo: env.GITHUB_REPOSITORY,
        ref,
        api: api ?? createGithubApi(env)
      })
    : new Map()
  const rows = files.map((file) => ({
    file,
    description: describeAttribution(attributions.get(file), ref)
  }))
  for (const { file, description } of rows) {
    reporter.log(visibleText(`${file}: changed in this push by ${description}`))
  }
  reporter.summary(renderAttributionSummary(rows))
}

export async function main({
  env = process.env,
  root = process.cwd(),
  invocationRoot = root,
  api
} = {}) {
  const reporter = createReporter(env)
  let range
  let files
  try {
    const head = (await git(['rev-parse', env.HEAD_SHA || 'HEAD'], root)).trim()
    const event = env.GITHUB_EVENT_NAME || 'workflow_dispatch'
    const { base, scope } = await resolveRange({ event, before: env.BEFORE_SHA, head, cwd: root })
    range = { base, head, scope }
    files = await changedLintableFiles(base, head, root)
  } catch (error) {
    reporter.error('Main-push lint', error.message)
    reporter.summary(`### Main-push lint failed\n\n${markdownText(error.message)}`)
    return 1
  }
  const rangeText = `${range.base.slice(0, 10)}..${range.head.slice(0, 10)}`
  reporter.log(`Linting ${files.length} changed candidate file(s) in ${rangeText}: ${range.scope}.`)
  let results = { diagnostics: [], incomplete: [], linted: 0 }
  if (files.length > 0) {
    try {
      const invocation = resolveOxlintInvocation(invocationRoot)
      results = collectBatchResults(await runOxlint(files, { cwd: root, invocation }))
    } catch (error) {
      results.incomplete.push({ files, output: `${error.message}\n` })
    }
  }
  const { diagnostics, incomplete, linted } = results
  // The verdict, locations and summary are published before any optional PR lookup.
  reportDiagnostics(diagnostics, reporter)
  reportIncomplete(incomplete, reporter)
  reporter.summary(
    renderLintSummary({
      range: rangeText,
      scope: range.scope,
      candidates: files.length,
      linted,
      diagnostics,
      incomplete
    })
  )
  reporter.log(`oxlint linted ${linted} of ${files.length} candidate file(s).`)
  await reportAttribution({ diagnostics, base: range.base, head: range.head, env, reporter, api })
  return diagnostics.length > 0 || incomplete.length > 0 ? 1 : 0
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  process.exitCode = await main()
}
