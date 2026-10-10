export function verifyPlaywrightParticipation(report, { titles, label, repetitions = 3 }) {
  const stats = report?.stats
  if (
    !stats ||
    stats.expected !== titles.length * repetitions ||
    stats.skipped !== 0 ||
    stats.unexpected !== 0 ||
    stats.flaky !== 0 ||
    report.errors?.length
  ) {
    throw new Error(`${label} participation failed: ${JSON.stringify(stats)}`)
  }
  const counts = new Map(titles.map((title) => [title, 0]))
  const visit = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        if (!counts.has(spec.title)) {
          throw new Error(`Unexpected ${label} scenario: ${spec.title}`)
        }
        for (const test of spec.tests ?? []) {
          if (
            test.expectedStatus !== 'passed' ||
            test.results?.length !== 1 ||
            test.results[0].status !== 'passed'
          ) {
            throw new Error(`${label} scenario did not pass without retries: ${spec.title}`)
          }
          counts.set(spec.title, counts.get(spec.title) + 1)
        }
      }
      visit(suite.suites)
    }
  }
  visit(report.suites)
  for (const [title, count] of counts) {
    if (count !== repetitions) {
      throw new Error(
        `${label} scenario requires ${repetitions === 3 ? 'three' : repetitions} executions: ${title} (${count})`
      )
    }
  }
}
