import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

describe('Git binary compatibility PR gate', () => {
  it('runs the real-binary contract at each compatibility boundary', () => {
    const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
    const step = workflow.jobs.git_compatibility.steps.find(
      (candidate) => candidate.name === 'Verify Git binary compatibility matrix'
    )

    expect(step?.run).toContain('git-2.25.5.tar.gz')
    // Why asserted: the sha256 check only runs on the build path, so a cached binary
    // must come from a key that pins the same version the tarball line declares.
    expect(step?.run).toContain('if [ ! -x "$source/git" ]; then')
    expect(step?.run).toContain('41662c52fc16fec4963bfc41075e71f8ead6b5e386797eb6f9a1111ff95a8ddf')
    expect(step?.run).toContain('ORCA_GIT_COMPAT_BINARY="$source/git"')
    expect(step?.run).toContain('alpine/git:edge-2.38.1|2.38.1')
    expect(step?.run).toContain('alpine/git:v2.49.1|2.49.1')
    expect(step?.run).toContain('ORCA_GIT_COMPAT_IMAGE="$image"')
    expect(step?.run).toContain('src/shared/git-binary-compatibility.test.ts')
    expect(step?.run).toContain('-j"$(nproc)"')
    expect(step?.run).toContain('pids+=("$!")')
    expect(step?.run).toContain('wait "$pid" || status=1')
  })

  it('restores the baseline Git build before the matrix runs', () => {
    const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
    const steps = workflow.jobs.git_compatibility.steps
    const cacheIndex = steps.findIndex((step) => step.name === 'Cache baseline Git build')
    const matrixIndex = steps.findIndex(
      (step) => step.name === 'Verify Git binary compatibility matrix'
    )

    expect(cacheIndex).toBeGreaterThanOrEqual(0)
    expect(cacheIndex).toBeLessThan(matrixIndex)
    // The cached path and the build path must be the same directory or the guard
    // above would rebuild on every run while still reporting a cache hit.
    expect(steps[cacheIndex].with.path).toBe('~/.cache/orca-git-compat/git-2.25.5')
    expect(steps[matrixIndex].run).toContain('source="$HOME/.cache/orca-git-compat/git-2.25.5"')
    expect(steps[cacheIndex].with.key).toContain('2.25.5')
  })
})
