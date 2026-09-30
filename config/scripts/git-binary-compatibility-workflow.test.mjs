import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const BASELINE_DIR = '~/.cache/orca-git-compat/git-2.25.5'
const BASELINE_ACTION = './.github/actions/prepare-git-compatibility'
const baselineSteps = parse(readFileSync(`${BASELINE_ACTION}/action.yml`, 'utf8')).runs.steps

const gateSteps = () =>
  parse(readFileSync('.github/workflows/pr.yml', 'utf8')).jobs.git_compatibility.steps

const stepNamed = (name) => gateSteps().find((step) => step.name === name)

describe('Git binary compatibility PR gate', () => {
  it('runs the real-binary contract at each compatibility boundary', () => {
    const run = stepNamed('Verify Git binary compatibility matrix')?.run

    expect(run).toContain('ORCA_GIT_COMPAT_BINARY="$HOME/.cache/orca-git-compat/git-2.25.5/git"')
    expect(run).toContain('alpine/git:edge-2.38.1|2.38.1')
    expect(run).toContain('alpine/git:v2.49.1|2.49.1')
    expect(run).toContain('ORCA_GIT_COMPAT_IMAGE="$image"')
    expect(run).toContain('src/shared/git-binary-compatibility.test.ts')
    expect(run).toContain('pids+=("$!")')
    expect(run).toContain('wait "$pid" || status=1')
  })

  it('builds the pinned baseline tarball into the cached directory', () => {
    const run = baselineSteps.find((step) => step.name === 'Build the baseline Git binary')?.run

    expect(run).toContain('git-2.25.5.tar.gz')
    // Why asserted: the sha256 check only runs on the build path, so a cached binary
    // must come from a key that pins the same version the tarball line declares.
    expect(run).toContain('if [ -x "$source/git" ]; then')
    expect(run).toContain('41662c52fc16fec4963bfc41075e71f8ead6b5e386797eb6f9a1111ff95a8ddf')
    expect(run).toContain('-j"$(nproc)"')
    expect(run).toContain('NO_GETTEXT=YesPlease NO_TCLTK=YesPlease NO_PYTHON=YesPlease git')
    expect(run).toContain('sha256sum --check')
    expect(run).toContain('find "$source" -name \'*.o\' -delete')
    // The cached path and the build path must be the same directory or the guard
    // above would rebuild on every run while still reporting a cache hit.
    expect(run).toContain('source="$HOME/.cache/orca-git-compat/git-2.25.5"')
  })

  it('finishes the baseline build before the timed lanes start', () => {
    const steps = gateSteps()
    const names = baselineSteps.map((step) => step.name)
    const cacheIndex = names.indexOf('Cache baseline Git build')
    const buildIndex = names.indexOf('Build the baseline Git binary')
    const prepareIndex = steps.findIndex((step) => step.uses === BASELINE_ACTION)
    const matrixIndex = steps.findIndex(
      (step) => step.name === 'Verify Git binary compatibility matrix'
    )

    expect(cacheIndex).toBeGreaterThanOrEqual(0)
    expect(cacheIndex).toBeLessThan(buildIndex)
    expect(prepareIndex).toBeGreaterThanOrEqual(0)
    expect(prepareIndex).toBeLessThan(matrixIndex)
    // Why asserted: each lane is bounded by Vitest's per-test timeout while it waits on
    // container starts, so a `make -j$(nproc)` sharing the runner shows up as a timeout
    // in whichever boundary case is running rather than as a slow build.
    expect(steps[matrixIndex].run).not.toContain('make -C')
    expect(baselineSteps[cacheIndex].with.path).toBe(BASELINE_DIR)
    expect(baselineSteps[cacheIndex].with.key).toBe(
      'git-compat-baseline-${{ runner.os }}-${{ runner.arch }}-2.25.5'
    )
  })

  it('warms the same baseline on main so newly opened PRs can restore it', () => {
    const warmer = parse(readFileSync('.github/workflows/ci-cache-warmup.yml', 'utf8'))
    expect(warmer.jobs.warm.steps.some((step) => step.uses === BASELINE_ACTION)).toBe(true)
    expect(warmer.on.push.paths).toContain('.github/actions/prepare-git-compatibility/**')
    expect(warmer.on.pull_request.paths).toContain('.github/actions/prepare-git-compatibility/**')
  })

  it('pulls every matrix image before any lane runs', () => {
    const run = stepNamed('Verify Git binary compatibility matrix')?.run
    // A lazy pull inside one lane stalls whatever test the sibling lane is timing.
    const [beforeLanes] = run.split('pids=()')

    expect(beforeLanes).toContain('docker pull --quiet "${spec%%|*}"')
  })
})
