import { writeFileSync } from 'node:fs'

export const TEST_REPORT_ENV = 'ORCA_CHECK_CHANGED_TEST_REPORT'

// Vitest's JSON report omits unhandled errors, which a repeat run must not mistake for a pass.
export default class CheckChangedReporter {
  onTestRunEnd(testModules, unhandledErrors, reason) {
    const file = process.env[TEST_REPORT_ENV]
    if (file) {
      writeFileSync(
        file,
        JSON.stringify({
          reason,
          unhandledErrors: unhandledErrors.length,
          failed: testModules
            .filter((module) => module.state() === 'failed')
            .map((module) => module.moduleId)
        })
      )
    }
  }
}
