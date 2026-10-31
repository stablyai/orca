import { expect, it } from 'vitest'
import { classifyPrJobs, PR_CHECK_JOBS, shouldRunPrChecks } from './pr-code-change-scope.mjs'

it('selects dependent Node checking only for the exact cloud owner support leaf', () => {
  const leaf = 'cloud/apps/push/src/push-owner-integration.test-fixture.ts'
  const result = classifyPrJobs([leaf])
  const shouldRun = shouldRunPrChecks([leaf])
  expect(result.should_run).toBe(shouldRun)
  expect(shouldRun).toBe(false)
  expect(result).toMatchObject({
    should_run: shouldRun,
    ...Object.fromEntries(
      PR_CHECK_JOBS.map((job) => [job, job === 'static_analysis' || job === 'typecheck'])
    )
  })
  expect(classifyPrJobs([leaf]).should_run).toBe(false)
  for (const file of [
    'cloud/apps/push/src/push-owner-live.test-fixture.ts',
    `${leaf}x`,
    'cloud/apps/push/src/index.ts'
  ]) {
    expect(classifyPrJobs([file]).typecheck, file).toBe(false)
  }
})
