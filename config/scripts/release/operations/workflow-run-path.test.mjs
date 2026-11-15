import { describe, expect, it } from 'vitest'
import { assertReleaseMacBuildRunIdentity } from './run-release-mac-build-workflow.mjs'
import { workflowRunPathMatches } from './workflow-run-path.mjs'

const FILE = '.github/workflows/release-cut.yml'

describe('workflowRunPathMatches', () => {
  it.each([FILE, `${FILE}@main`, `${FILE}@refs/heads/main`])('accepts %s', (path) => {
    expect(workflowRunPathMatches(path, FILE)).toBe(true)
  })

  it.each([
    `${FILE}@feature`,
    `${FILE}@refs/heads/feature`,
    `${FILE}@refs/tags/main`,
    `${FILE}@`,
    `${FILE}@main@main`,
    `${FILE}x@main`,
    '.github/workflows/release-mac-build.yml@main',
    `@main`,
    '',
    undefined
  ])('refuses %s', (path) => {
    expect(workflowRunPathMatches(path, FILE)).toBe(false)
  })

  it('refuses an empty expected file', () => {
    expect(workflowRunPathMatches('@main', '')).toBe(false)
  })
})

describe('mac build dispatcher run identity', () => {
  const options = {
    workflow: 'release-mac-build.yml',
    tag: 'v1.2.3',
    releaseRunId: '42',
    ref: 'main'
  }
  const run = (path) => ({
    id: 7,
    event: 'workflow_dispatch',
    path,
    display_title: 'Mac release build v1.2.3 (42)',
    head_branch: 'main',
    head_sha: 'a'.repeat(40),
    run_attempt: 1
  })

  it.each([
    ['.github/workflows/release-mac-build.yml', true],
    ['.github/workflows/release-mac-build.yml@main', true],
    ['.github/workflows/release-mac-build.yml@refs/heads/main', true],
    ['.github/workflows/release-mac-build.yml@feature', false]
  ])('%s', (path, ok) => {
    const check = () => assertReleaseMacBuildRunIdentity(run(path), options, { id: 7 })
    if (ok) {
      expect(check()).toEqual(run(path))
    } else {
      expect(check).toThrow(/does not match/)
    }
  })
})
