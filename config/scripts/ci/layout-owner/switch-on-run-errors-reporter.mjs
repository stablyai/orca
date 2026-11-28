// Records what Vitest's JSON report leaves out: module-level errors (collection and hooks) and unhandled errors.
import { writeFileSync } from 'node:fs'
import { relative } from 'node:path'

const OUTPUT = process.env.ORCA_SWITCH_ON_RUN_ERRORS ?? 'switch-on-run-errors.json'
const firstLine = (error) => String(error?.message ?? error).split('\n')[0]

export default class SwitchOnRunErrorsReporter {
  onTestRunEnd(testModules, unhandledErrors) {
    const moduleErrors = testModules.flatMap((testModule) =>
      testModule.errors().map((error) => ({
        file: relative(process.cwd(), testModule.moduleId),
        message: firstLine(error)
      }))
    )
    const unhandled = unhandledErrors.map((error) => ({
      file: error.VITEST_TEST_PATH ? relative(process.cwd(), error.VITEST_TEST_PATH) : null,
      test: error.VITEST_TEST_NAME ?? null,
      message: firstLine(error)
    }))
    writeFileSync(OUTPUT, `${JSON.stringify({ moduleErrors, unhandled }, null, 2)}\n`)
  }
}
