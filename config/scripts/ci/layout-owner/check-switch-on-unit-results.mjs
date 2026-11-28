// Switch-on unit lane: every listed census failure must still fail, and nothing else may fail:
// no other test, no suite or hook error, and no unhandled error unless the list names it (`unhandled` entries).
// A listed test that passes means its bug was fixed: delete its entry. With the switch off the listed tests pass, so this also fails.
import { existsSync, readFileSync } from 'node:fs'

const [resultsPath, manifestPath, runErrorsPath] = process.argv.slice(2)
const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
const known = JSON.parse(readFileSync(manifestPath, 'utf8'))
const key = (file, test) => `${file} > ${test}`
const expected = new Map(
  known.filter((entry) => entry.test).map((entry) => [key(entry.file, entry.test), entry.row])
)
const knownUnhandled = known.filter((entry) => entry.unhandled)

const failed = new Set()
const ran = new Set()
const problems = []
for (const file of results.testResults) {
  const name = file.name.replace(`${process.cwd()}/`, '')
  const suiteError = (file.message ?? '').split('\n')[0]
  if (suiteError) {
    problems.push(`${name} failed outside its tests (load, suite or hook): ${suiteError}`)
  } else if (
    file.status === 'failed' &&
    !file.assertionResults.some((test) => test.status === 'failed')
  ) {
    problems.push(`${name} failed with no failing test`)
  }
  for (const test of file.assertionResults) {
    ran.add(key(name, test.fullName))
    if (test.status === 'failed') {
      failed.add(key(name, test.fullName))
    }
  }
}
for (const test of failed) {
  if (!expected.has(test)) {
    problems.push(`new switch-on failure: ${test}`)
  }
}
for (const [test, row] of expected) {
  if (!ran.has(test)) {
    problems.push(`listed test did not run (renamed or deleted? update the list): ${test}`)
  } else if (!failed.has(test)) {
    problems.push(`listed test now passes (census row ${row} fixed? delete its entry): ${test}`)
  }
}
// Vitest's JSON report omits these; the run-errors reporter records them.
if (!runErrorsPath || !existsSync(runErrorsPath)) {
  problems.push(
    `no run-errors report at ${runErrorsPath}: run Vitest with switch-on-run-errors-reporter.mjs`
  )
} else {
  const runErrors = JSON.parse(readFileSync(runErrorsPath, 'utf8'))
  for (const error of runErrors.moduleErrors) {
    problems.push(`${error.file} failed outside its tests: ${error.message}`)
  }
  const seen = new Set()
  for (const error of runErrors.unhandled) {
    const entry = knownUnhandled.find(
      (candidate) => candidate.file === error.file && error.message.startsWith(candidate.unhandled)
    )
    if (entry) {
      seen.add(entry)
    } else {
      problems.push(`unhandled error from ${error.file ?? 'an unknown file'}: ${error.message}`)
    }
  }
  for (const entry of knownUnhandled) {
    if (!seen.has(entry)) {
      // Timing decides whether a stray rejection lands inside the run, so a missing one only warns.
      console.warn(
        `listed unhandled error did not occur (row ${entry.row}): ${entry.file}: ${entry.unhandled}`
      )
    }
  }
}
const total = results.numTotalTests ?? ran.size
console.log(
  `${total} tests ran, ${failed.size} failed, ${expected.size} known switch-on failures listed`
)
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
