import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))

function runnerFor(job, os, fast) {
  return runInNewContext(job['runs-on'].slice(3, -2), {
    inputs: { fast_runners: fast },
    matrix: { os },
    fromJSON: JSON.parse
  })
}

it('keeps faster runners opt-in for both reusable and manual qualification', () => {
  for (const trigger of ['workflow_call', 'workflow_dispatch']) {
    expect(workflow.on[trigger].inputs.fast_runners).toMatchObject({
      type: 'boolean',
      default: false
    })
  }
})

it.each([
  ['ubuntu-22.04', 'blacksmith-8vcpu-ubuntu-2204'],
  ['ubuntu-24.04-arm', 'blacksmith-8vcpu-ubuntu-2404-arm'],
  ['macos-15', 'blacksmith-6vcpu-macos-15'],
  ['macos-15-intel', 'macos-15-large'],
  ['windows-2022', 'blacksmith-8vcpu-windows-2025'],
  ['windows-11-arm', 'orca-windows-11-arm64-8core']
])('preserves the qualification architecture for %s', (os, fastRunner) => {
  expect(runnerFor(workflow.jobs.persistence, os, false)).toBe(os)
  expect(runnerFor(workflow.jobs.persistence, os, true)).toBe(fastRunner)
  expect(runnerFor(workflow.jobs.persistence, os, undefined)).toBe(os)
})

it('retains both Linux architectures and the pinned libc qualification containers', () => {
  for (const name of ['linux_glibc_floor', 'linux_musl']) {
    const job = workflow.jobs[name]
    expect(job.strategy.matrix.os).toEqual(['ubuntu-22.04', 'ubuntu-24.04-arm'])
    for (const os of job.strategy.matrix.os) {
      expect(runnerFor(job, os, false)).toBe(os)
      expect(runnerFor(job, os, true)).toBe(
        `blacksmith-8vcpu-ubuntu-${os === 'ubuntu-22.04' ? '2204' : '2404-arm'}`
      )
    }
  }
  const floor = workflow.jobs.linux_glibc_floor
  expect(floor.container).toBe('${{ matrix.image }}')
  for (const { image } of floor.strategy.matrix.include) {
    expect(image).toMatch(/^quay\.io\/pypa\/manylinux_2_28_.*@sha256:/)
  }
  expect(workflow.jobs.linux_glibc217_compat.steps.map((step) => step.run).join('\n')).toContain(
    'quay.io/pypa/manylinux2014_x86_64@sha256:'
  )
})

it.each([
  ['changes', 'ubuntu-latest', 'blacksmith-2vcpu-ubuntu-2404'],
  ['mobile_web_bundle', 'ubuntu-latest', 'blacksmith-8vcpu-ubuntu-2404'],
  ['desktop_template', 'ubuntu-latest', 'blacksmith-4vcpu-ubuntu-2404'],
  ['linux_glibc217_compat', 'ubuntu-22.04', 'blacksmith-8vcpu-ubuntu-2204']
])('sizes %s for its work without changing default callers', (name, hostedRunner, fastRunner) => {
  expect(runnerFor(workflow.jobs[name], undefined, false)).toBe(hostedRunner)
  expect(runnerFor(workflow.jobs[name], undefined, true)).toBe(fastRunner)
})

it('still builds and uploads cross-compiled Windows template addons on the x64 lane', () => {
  const steps = workflow.jobs.persistence.steps
  const launcher = steps.find((step) => step.uses?.includes('prepare-windows-cli-launcher'))
  for (const [os, arch, buildTemplate, expectedArches, expectedUpload] of [
    ['windows-2022', 'X64', true, 'x64 arm64', true],
    ['windows-2022', 'X64', false, 'x64', false],
    ['windows-11-arm', 'ARM64', true, 'arm64', false],
    ['windows-11-arm', 'ARM64', false, 'arm64', false]
  ]) {
    for (const hasSecurityBuilder of [true, false]) {
      const ctx = {
        inputs: { build_template: buildTemplate },
        matrix: { os },
        runner: { arch },
        hashFiles: () => (hasSecurityBuilder ? 'fixture-builder-hash' : '')
      }
      for (const fragment of ['process-table addons', 'CLI launchers', 'security addons']) {
        const upload = steps.find((step) => step.name?.includes(`Keep the Windows ${fragment}`))
        expect(runInNewContext(upload.if, ctx), `${os} ${fragment}`).toBe(
          expectedUpload && (fragment !== 'security addons' || hasSecurityBuilder)
        )
      }
      expect(runInNewContext(launcher.with.arches.slice(3, -2), ctx)).toBe(expectedArches)
    }
  }
})
