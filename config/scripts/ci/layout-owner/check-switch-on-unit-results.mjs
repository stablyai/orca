// Switch-on unit lane: every listed census failure must still fail, and nothing else may fail.
// A listed test that passes means its bug was fixed: delete its entry. With the switch off the listed tests pass, so this also fails.
import { readFileSync } from 'node:fs'

const [resultsPath, manifestPath] = process.argv.slice(2)
const results = JSON.parse(readFileSync(resultsPath, 'utf8'))
const known = JSON.parse(readFileSync(manifestPath, 'utf8'))
const key = (file, test) => `${file} > ${test}`
const expected = new Map(known.map((entry) => [key(entry.file, entry.test), entry.row]))

const failed = new Set()
const ran = new Set()
const problems = []
for (const file of results.testResults) {
  const name = file.name.replace(`${process.cwd()}/`, '')
  if (file.status === 'failed' && file.assertionResults.length === 0) {
    problems.push(`${name} did not load: ${(file.message ?? '').split('\n')[0]}`)
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
const total = results.numTotalTests ?? ran.size
console.log(
  `${total} tests ran, ${failed.size} failed, ${expected.size} known switch-on failures listed`
)
if (problems.length > 0) {
  console.error(problems.join('\n'))
  process.exit(1)
}
