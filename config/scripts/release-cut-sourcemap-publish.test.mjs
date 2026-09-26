import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const buildSteps = parse(
  readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
).jobs.build.steps

function stepIndex(name) {
  const index = buildSteps.findIndex((step) => step.name === name)
  expect(index, `missing build step: ${name}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('release-cut source map publication', () => {
  it('bundles and uploads main source maps from exactly one platform leg', () => {
    const bundle = buildSteps[stepIndex('Bundle main-process source maps')]
    const publish = buildSteps[stepIndex('Publish main-process source maps')]

    // Why: the main bundle is platform-independent, so duplicating the ~8MB
    // artifact across legs would only race the uploads against each other.
    for (const step of [bundle, publish]) {
      expect(step.if).toContain('linux-x64')
    }

    expect(bundle.run).toContain("find out/main -name '*.js.map'")
    expect(publish.with.command).toContain('gh release upload')
    expect(publish.with.command).toContain('orca-sourcemaps-')
  })

  it('stages the bundle outside the checkout so packaging cannot absorb it', () => {
    // Why: electron-builder's `files` is all negations, so app-builder prepends
    // `**/*` and packs any stray workspace-root file into app.asar.
    const bundle = buildSteps[stepIndex('Bundle main-process source maps')]
    const publish = buildSteps[stepIndex('Publish main-process source maps')]

    expect(bundle.run).toContain('"$RUNNER_TEMP/orca-sourcemaps-$TAG.zip"')
    expect(bundle.run).not.toMatch(/zip[^\n]*\s"orca-sourcemaps-/)
    expect(publish.with.command).toContain('runner.temp')
  })

  it('fails only when a map-enabled cut emits no source maps', () => {
    // Why: legacy tags predate source-map publication, but a newer tag that
    // enables hidden maps must still fail loudly if the build regresses.
    const bundle = buildSteps[stepIndex('Bundle main-process source maps')]
    expect(bundle.id).toBe('bundle-main-sourcemaps')
    expect(bundle.run).toContain('grep -Eq')
    expect(bundle.run).toContain('sourcemap:[[:space:]]*')
    expect(bundle.run).toContain('has_maps=false')
    expect(bundle.run).toContain('has_maps=true')
    expect(bundle.run).toContain('::error::')
    expect(bundle.run).toContain('exit 1')
  })

  it('skips publication for legacy cut refs without hidden source maps', () => {
    const publish = buildSteps[stepIndex('Publish main-process source maps')]
    expect(publish.if).toContain("steps.bundle-main-sourcemaps.outputs.has_maps == 'true'")
  })

  it('bundles maps after the build and before packaging strips them', () => {
    const bundle = stepIndex('Bundle main-process source maps')
    expect(bundle).toBeGreaterThan(stepIndex('Build app'))
    expect(stepIndex('Publish main-process source maps')).toBeGreaterThan(bundle)
    expect(bundle).toBeLessThan(stepIndex('Publish release artifacts (Linux)'))
  })
})
