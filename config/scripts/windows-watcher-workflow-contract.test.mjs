import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = (name) => parse(readFileSync(`.github/workflows/${name}.yml`, 'utf8'))
const consumers = [
  ['pr', 'managed_hook_bun'],
  ['pr', 'package'],
  ['pr', 'package_windows'],
  ['bun-profile-tests', 'persistence'],
  ['bun-profile-tests', 'owned_companions'],
  ['adhoc-mac-build', 'build-adhoc-mac'],
  ['daily-mac-build', 'build-daily-mac'],
  ['dev-channel-win-build', 'build-win'],
  ['e2e', 'build'],
  ['hourly-mac-build', 'build-hourly-mac'],
  ['packaged-browser-e2e', 'compatibility'],
  ['release-cut', 'build'],
  ['release-mac-build', 'build-mac'],
  ['terminal-ime-e2e', 'linux-wayland'],
  ['win-crash-survival-e2e', 'crash-survival'],
  ['win-update-survival-e2e', 'survival'],
  ['windows-signing-rehearsal', 'rehearse'],
  ['windows-wsl-e2e', 'wsl-terminal']
]

describe('qualified Windows watcher distribution', () => {
  it.each(consumers)('%s/%s waits for and loads its qualified artifacts', (name, jobName) => {
    const jobs = workflow(name).jobs
    const job = jobs[jobName]
    expect([job.needs].flat()).toContain('windows_watcher')
    const producer = jobs.windows_watcher
    expect(producer.uses).toBe('./.github/workflows/windows-watcher-artifacts.yml')
    expect(producer.permissions).toEqual({ contents: 'read' })
    const loader = job.steps.find(
      (step) =>
        step.uses === './.github/actions/load-windows-watcher-artifacts' ||
        step.with?.path === '.build/windows-watcher'
    )
    expect(loader).toBeDefined()
    const prefix = producer.with?.artifact_prefix ?? 'windows-watcher'
    if (loader.with?.pattern) {
      expect(loader.with.pattern).toBe(`${prefix}-*`)
      expect(loader.with['merge-multiple']).toBe(true)
    } else {
      expect(prefix).toBe('windows-watcher')
    }
  })

  it('reuses the PR producer for unit shards and can produce artifacts when called separately', () => {
    const pr = workflow('pr').jobs
    expect(pr.test.needs).toContain('windows_watcher')
    expect(pr.test.with.windows_watcher_ready).toBe(true)
    const unit = workflow('unit-tests').jobs
    expect(unit.windows_watcher.if).toBe('${{ !inputs.windows_watcher_ready }}')
    for (const name of ['test', 'relay_integration']) {
      expect(unit[name].needs).toBe('windows_watcher')
      expect(unit[name].if).toContain("needs.windows_watcher.result == 'success'")
      expect(
        unit[name].steps.some(
          (step) => step.uses === './.github/actions/load-windows-watcher-artifacts'
        )
      ).toBe(true)
    }
  })

  it('pins the daily desktop build to the same source as its native artifacts', () => {
    const producer = workflow('windows-watcher-artifacts')
    expect(producer.on.workflow_call.outputs.source_sha.value).toBe(
      '${{ jobs.source.outputs.sha }}'
    )
    const checkout = workflow('daily-mac-build').jobs['build-daily-mac'].steps.find(
      (step) => step.uses === 'actions/checkout@v6'
    )
    expect(checkout.with.ref).toBe('${{ needs.windows_watcher.outputs.source_sha }}')
  })

  it('publishes and caches only after ordinary and sanitizer qualification', () => {
    const producer = workflow('windows-watcher-artifacts')
    expect(producer.permissions).toEqual({ contents: 'read' })
    expect(producer.jobs.build.strategy.matrix.os).toEqual(['windows-2022', 'windows-11-arm'])
    expect(producer.jobs.build.steps[0].with.ref).toBe('${{ needs.source.outputs.sha }}')
    expect(producer.jobs.build.if).toBe("needs.source.outputs.supported == 'true'")
    const steps = producer.jobs.build.steps
    const sanitize = steps.findIndex((step) => step.name === 'Verify cancellation memory safety')
    const save = steps.findIndex((step) => step.uses === 'actions/cache/save@v5')
    const upload = steps.findIndex((step) => step.uses === 'actions/upload-artifact@v7')
    expect(sanitize).toBeGreaterThan(
      steps.findIndex((step) => step.name === 'Verify native registration under Bun')
    )
    expect(save).toBeGreaterThan(sanitize)
    expect(upload).toBeGreaterThan(save)
    expect(steps[upload].with.path).toBe('.build/windows-watcher/*/')
    const cache = steps.find((step) => step.id === 'native_cache')
    for (const input of [
      'pnpm-lock.yaml',
      'src/shared/orcad-bun-runtime.ts',
      'parcel-watcher-windows-readiness.patch',
      'build-windows-watcher-addon.mjs',
      'windows-watcher-readiness-smoke.mjs',
      'windows-pe-machine.cjs'
    ]) {
      expect(cache.with.key).toContain(input)
    }
  })
})
