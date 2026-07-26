import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

describe('Git binary compatibility PR gate', () => {
  it('runs the real-binary contract at each compatibility boundary', () => {
    const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
    const step = workflow.jobs.verify.steps.find(
      (candidate) => candidate.name === 'Verify Git binary compatibility matrix'
    )

    expect(step?.run).toContain('git-2.25.5.tar.gz')
    expect(step?.run).toContain('41662c52fc16fec4963bfc41075e71f8ead6b5e386797eb6f9a1111ff95a8ddf')
    expect(step?.run).toContain('ORCA_GIT_COMPAT_BINARY="$source/git"')
    expect(step?.run).toContain('alpine/git:edge-2.38.1|2.38.1')
    expect(step?.run).toContain('alpine/git:v2.49.1|2.49.1')
    expect(step?.run).toContain('ORCA_GIT_COMPAT_IMAGE="$image"')
    expect(step?.run).toContain('src/shared/git-binary-compatibility.test.ts')
  })
})
