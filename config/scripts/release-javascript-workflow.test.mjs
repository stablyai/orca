import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const release = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
const mac = parse(readFileSync('.github/workflows/release-mac-build.yml', 'utf8'))
const javascript = parse(readFileSync('.github/workflows/release-javascript.yml', 'utf8'))
const comparison = parse(readFileSync('.github/workflows/release-javascript-benchmark.yml', 'utf8'))

describe('release JavaScript job boundaries', () => {
  it('compiles the release tag while blocking gates run, with no publishing permission', () => {
    const job = release.jobs['release-javascript']
    expect(job.needs).toBe('cut')
    expect(job.permissions).toEqual({ contents: 'read' })
    expect(job.with.ref).toBe('refs/tags/${{ needs.cut.outputs.tag }}')
    expect(javascript.permissions).toEqual({ contents: 'read' })
    expect(javascript.jobs.bundle['runs-on']).toBe('ubuntu-latest')
    expect(javascript.jobs.bundle.steps[0].with.ref).toBe('${{ inputs.ref }}')
    expect(javascript.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
  })

  it.each(['build', 'build-mac'])(
    'keeps %s behind signing gates and the bundle verdict',
    (name) => {
      const job = release.jobs[name]
      expect(job.needs).toEqual(
        expect.arrayContaining([
          'cut',
          'create-release',
          'release-preflight',
          'relay-windows-process-tree',
          'release-javascript'
        ])
      )
      expect(job.if).toContain("needs.release-preflight.result == 'success'")
      expect(job.if).toContain("needs.release-javascript.result == 'success'")
    }
  )

  it('retains full compilation for old refs but fails rather than rebuilding a broken shared artifact', () => {
    const job = javascript.jobs.bundle
    const support = job.steps.find((step) => step.id === 'source')
    expect(support.run).toContain('build:release:javascript')
    expect(support.run).toContain('build:release:host')
    const compile = job.steps.find((step) => step.name === 'Build and archive release JavaScript')
    expect(compile.if).toBe("steps.source.outputs.supported == 'true'")
    const download = release.jobs.build.steps.find(
      (step) => step.name === 'Download release JavaScript'
    )
    expect(download.if).toBe("needs.release-javascript.outputs.supported == 'true'")
    expect(download['continue-on-error']).toBeUndefined()
    const build = release.jobs.build.steps.find((step) => step.name === 'Build app')
    expect(build.run).toMatch(/artifact\.mjs restore\s+pnpm run build:release:host/)
    expect(build.run).toMatch(/else\s+pnpm run build:release/)
    expect(build['continue-on-error']).toBeUndefined()
  })

  it('restores the same parent-run bundle on macOS and retains native and runtime checks', () => {
    const download = mac.jobs['build-mac'].steps.find(
      (step) => step.name === 'Download release JavaScript from the release run'
    )
    expect(download.with['run-id']).toBe('${{ inputs.release_run_id }}')
    expect(download.with.name).toBe('release-javascript')
    const build = mac.jobs['build-mac'].steps.find((step) => step.name === 'Build app')
    expect(build.env.ORCA_RELEASE_JAVASCRIPT_SOURCE_SHA).toBe('${{ inputs.javascript_source_sha }}')
    expect(build.run).toContain('pnpm run build:release:host')
    for (const job of [release.jobs.build, mac.jobs['build-mac']]) {
      expect(job.steps.map((step) => step.name)).toEqual(
        expect.arrayContaining([
          'Gate runtime file-watcher process isolation',
          'Gate SSH relay watcher process isolation'
        ])
      )
    }
  })

  it('compares both build paths on all packaging hosts without publishing credentials', () => {
    expect(comparison.jobs.measure.strategy.matrix.mode).toEqual(['baseline', 'shared'])
    expect(comparison.jobs.measure.strategy.matrix.host).toHaveLength(4)
    expect(comparison.permissions).toEqual({ contents: 'read' })
    expect(comparison.env.ORCA_POSTHOG_WRITE_KEY).toBe('ci-build-comparison')
    expect(comparison.jobs.bundle.secrets.ORCA_POSTHOG_WRITE_KEY).toBe('ci-build-comparison')
    const steps = comparison.jobs.measure.steps
    expect(steps.find((step) => step.name === 'Download shared JavaScript').if).toBe(
      "matrix.mode == 'shared'"
    )
    expect(steps.find((step) => step.name === 'Measure release build').run).toContain(
      'release-javascript-benchmark.mjs'
    )
  })
})
