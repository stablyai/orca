import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const WSL_TEST_TITLES = [
  'tab-bar + menu launches an agent inside WSL @tab-bar-agent-launch-golden',
  'WSL terminal keyboard paste preserves Linux shell content with one PTY owner',
  'existing WSL terminal keeps paste runtime after default shell changes'
]

export function verifyWslParticipation(report) {
  const stats = report?.stats
  if (
    !stats ||
    stats.expected !== 9 ||
    stats.skipped !== 0 ||
    stats.unexpected !== 0 ||
    stats.flaky !== 0 ||
    report.errors?.length
  ) {
    throw new Error(`WSL participation failed: ${JSON.stringify(stats)}`)
  }
  const counts = new Map(WSL_TEST_TITLES.map((title) => [title, 0]))
  const visit = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        if (!counts.has(spec.title)) {
          throw new Error(`Unexpected WSL scenario: ${spec.title}`)
        }
        for (const test of spec.tests ?? []) {
          if (
            test.expectedStatus !== 'passed' ||
            test.results?.length !== 1 ||
            test.results[0].status !== 'passed'
          ) {
            throw new Error(`WSL scenario did not pass without retries: ${spec.title}`)
          }
          counts.set(spec.title, counts.get(spec.title) + 1)
        }
      }
      visit(suite.suites)
    }
  }
  visit(report.suites)
  for (const [title, count] of counts) {
    if (count !== 3) {
      throw new Error(`WSL scenario requires three executions: ${title} (${count})`)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyWslParticipation(JSON.parse(readFileSync(process.argv[2], 'utf8')))
  console.log('All three WSL scenarios passed three times without skips or retries.')
}
