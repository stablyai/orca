import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const TITLES = [
  'saves, selects, checks launch and removes synthetic accounts without changing normal HOME',
  'keeps a second explicit distro unchanged'
]

export function verifyWslAccountParticipation(report) {
  const files = report?.testResults
  if (
    report?.success !== true ||
    report.numTotalTests !== 2 ||
    report.numPassedTests !== 2 ||
    report.numFailedTests !== 0 ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    !Array.isArray(files) ||
    files.length !== 1
  ) {
    throw new Error('WSL account participation failed: both scenarios must pass without skips')
  }
  const file = files[0]
  const assertions = file?.assertionResults
  if (
    typeof file?.name !== 'string' ||
    !/(?:^|[\\/])native-wsl-accounts\.wsl\.test\.ts$/.test(file.name) ||
    file.status !== 'passed' ||
    !Array.isArray(assertions) ||
    assertions.length !== 2 ||
    !TITLES.every(
      (title) =>
        assertions.filter(
          (assertion) => assertion?.title === title && assertion.status === 'passed'
        ).length === 1
    )
  ) {
    throw new Error('WSL account participation failed: both named account scenarios are required')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyWslAccountParticipation(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log('Both real WSL account scenarios passed without skips.')
}
