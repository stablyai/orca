import { appendFileSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { trackE2eFailures } from './ci-e2e-failure-tracking.mjs'

export function e2eFailureSummary(report) {
  const failures = []
  let passed = 0
  let skipped = 0
  function visit(suite, parents = [], parentFile) {
    const titles = [...parents, suite.title].filter(Boolean)
    const file = suite.file ?? parentFile
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === 'expected') {
          passed++
          continue
        }
        if (test.status === 'skipped') {
          skipped++
          continue
        }
        const errors = test.results.flatMap((result) => result.errors ?? [])
        failures.push({
          file: spec.file ?? file,
          title: [...titles, spec.title].join(' › '),
          project: test.projectName,
          status: test.status,
          message: errors
            .map((error) => error.message ?? error.value ?? '')
            .join('\n')
            .slice(0, 2000)
        })
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child, titles, file)
    }
  }
  for (const suite of report.suites ?? []) {
    visit(suite)
  }
  return { passed, skipped, failures, errors: report.errors ?? [] }
}

export function renderE2eFailures(summary, records = [], now = new Date()) {
  const escape = (value) =>
    String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
  const tracked = trackE2eFailures(summary.failures, records, now)
  const details = (failure) =>
    `<details><summary>${escape(failure.status)}: ${escape(failure.file)} — ${escape(failure.title)}</summary><pre>${escape(failure.message)}</pre></details>`
  return [
    '## E2E results',
    '',
    `${summary.passed} expected results; ${summary.skipped} skipped; ${summary.failures.length} unexpected/flaky results; ${summary.errors.length} run errors.`,
    '',
    `### Untracked failures (${tracked.untracked.length})`,
    '',
    ...tracked.untracked.map(details),
    '',
    `### Tracked failures (${tracked.known.length})`,
    '',
    ...tracked.known.flatMap((failure) => [
      details(failure),
      `Owner: ${escape(failure.tracking.owner)}; ${escape(failure.tracking.issue)}; expires ${escape(failure.tracking.expires)}.`
    ]),
    ...(tracked.invalid.length
      ? [`${tracked.invalid.length} invalid/expired tracking entries were not used.`]
      : []),
    ...summary.errors.map((error) => `<pre>${escape(error.message ?? error.value)}</pre>`),
    '',
    'Failures retain their original verdict. Repeated failures need a tracked owner, reproduction and review date; do not treat a red baseline as passing.',
    ''
  ].join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const summary = e2eFailureSummary(JSON.parse(readFileSync(process.argv[2], 'utf8')))
    const records = JSON.parse(
      readFileSync(new URL('../e2e-failure-tracking.json', import.meta.url), 'utf8')
    )
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, renderE2eFailures(summary, records))
  } catch (error) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `E2E report unavailable (${error.code ?? 'invalid report'}); inspect the failing step and traces.\n`
    )
  }
}
