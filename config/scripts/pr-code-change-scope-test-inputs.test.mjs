import { expect, it } from 'vitest'
import { classifyPrJobs, PR_CHECK_JOBS } from './pr-code-change-scope.mjs'

it.each([
  'config/scripts/pr-code-change-scope.test.mjs',
  'config/scripts/pr-code-change-scope-released-phone.test.mjs',
  'config/scripts/pr-package-test-paths.test.mjs'
])('keeps full units and preflight without forcing unrelated lanes for %s', (file) => {
  for (const files of [[file], [file, 'AGENTS.md']]) {
    const result = classifyPrJobs(files)
    expect(PR_CHECK_JOBS.filter((job) => result[job])).toEqual([
      'static_analysis',
      'typecheck',
      'test'
    ])
  }
  const mixed = classifyPrJobs([file, 'src/shared/git-capability-cache.ts'])
  expect(PR_CHECK_JOBS.filter((job) => mixed[job])).toEqual([
    'static_analysis',
    'typecheck',
    'git_compatibility',
    'test',
    'package',
    'package_windows'
  ])
})

it.each([
  'config/scripts/pr-code-change-scope.mjs',
  'config/scripts/pr-code-change-scope-next.mjs',
  'config/scripts/pr-package-test-paths.mjs',
  '.github/workflows/pr.yml',
  '.github/actions/install-node-dependencies/action.yml'
])('keeps every lane for routing or execution changes mixed with routing tests: %s', (file) => {
  const result = classifyPrJobs(['config/scripts/pr-code-change-scope.test.mjs', file])
  for (const job of PR_CHECK_JOBS) {
    expect(result[job], job).toBe(true)
  }
})
