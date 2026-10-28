import { expect, it } from 'vitest'
import { e2eFailureSummary, renderE2eFailures } from './ci-e2e-failure-summary.mjs'
import { trackE2eFailures } from './ci-e2e-failure-tracking.mjs'

it('requires exact failures with an owner, issue and unexpired review date', () => {
  const failure = {
    file: 'test.spec.ts',
    title: 'case',
    project: 'electron',
    message: 'expected focus failed'
  }
  const record = {
    ...failure,
    message: 'expected focus',
    owner: '@owner',
    issue: 'https://github.com/stablyai/orca/issues/123',
    expires: '2026-10-01'
  }
  const now = new Date('2026-09-28')
  expect(trackE2eFailures([failure], [null, record], now)).toMatchObject({
    known: [{ ...failure, tracking: record }],
    invalid: [null]
  })
  expect(trackE2eFailures([failure], null, now).untracked).toEqual([failure])
  for (const change of [
    { expires: '2026-09-27' },
    { expires: '2026-09-31' },
    { owner: '' },
    { issue: '' },
    { title: 'different' },
    { message: 'different' },
    { project: 'other' }
  ]) {
    expect(trackE2eFailures([failure], [{ ...record, ...change }], now).untracked).toEqual([
      failure
    ])
  }
})

it('keeps failure, flaky, skipped and startup-error evidence separate', () => {
  const report = {
    errors: [{ message: 'startup failed' }],
    suites: [
      {
        title: 'file',
        file: 'tests/e2e/test.spec.ts',
        suites: [
          {
            title: 'feature',
            specs: [
              {
                title: 'case',
                tests: [
                  { status: 'expected' },
                  { status: 'skipped' },
                  {
                    status: 'unexpected',
                    projectName: 'electron-headless',
                    results: [{ errors: [{ message: '<timeout>' }] }]
                  },
                  {
                    status: 'flaky',
                    results: [{ errors: [{ message: 'first try' }] }, { errors: [] }]
                  }
                ]
              }
            ]
          }
        ]
      }
    ]
  }
  const summary = e2eFailureSummary(report)
  expect(summary).toMatchObject({ passed: 1, skipped: 1, errors: report.errors })
  expect(summary.failures).toHaveLength(2)
  expect(summary.failures[0].title).toBe('file › feature › case')
  expect(renderE2eFailures(summary)).toContain('&lt;timeout&gt;')
  expect(renderE2eFailures(summary)).toContain('startup failed')
})
