import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { packagedTerminalFloorDockerArgs } from './run-linux-packaged-terminal-floor-smoke.mjs'

describe('packaged terminal Linux floor qualification', () => {
  it('isolates exact packaged artifacts from writable fixture state on Ubuntu 20.04', () => {
    const args = packagedTerminalFloorDockerArgs({
      appDirectory: '/tmp/app with spaces',
      fixtureDirectory: '/tmp/gate'
    })
    expect(args).toContain('type=bind,src=/tmp/app with spaces,dst=/artifact,readonly')
    expect(args).toContain('type=bind,src=/tmp/gate,dst=/qualification,readonly')
    expect(args).toContain('ubuntu:20.04')
    expect(args).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(args).toContain('ORCA_BACKGROUND_LAUNCH=1')
    expect(args.at(-3)).toContain('/artifact/orca-ide')
    expect(args.at(-3)).toContain('/artifact/resources')
  })
  it('does not splice caller paths into a shell command', () => {
    const args = packagedTerminalFloorDockerArgs({
      appDirectory: '/tmp/$(unexpected)',
      fixtureDirectory: '/tmp/gate'
    })
    expect(args.at(-3)).not.toContain('unexpected')
    expect(args).toContain('type=bind,src=/tmp/$(unexpected),dst=/artifact,readonly')
    expect(() =>
      packagedTerminalFloorDockerArgs({
        appDirectory: '/tmp/app,readonly',
        fixtureDirectory: '/tmp/gate'
      })
    ).toThrow('commas')
  })
  it('offers nonpublishing native Linux package qualification only by explicit dispatch', () => {
    const workflow = parse(readFileSync('.github/workflows/bun-profile-tests.yml', 'utf8'))
    expect(workflow.on.workflow_dispatch.inputs.linux_package).toMatchObject({
      type: 'boolean',
      default: false
    })
    const job = workflow.jobs.linux_package
    expect(job.if).toContain("github.event_name == 'workflow_dispatch'")
    expect(job.if).toContain('inputs.linux_package')
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(job.permissions).toBeUndefined()
    expect(job.environment).toBeUndefined()
    expect(JSON.stringify(job)).not.toContain('secrets.')
    expect(job.env.ORCA_BACKGROUND_LAUNCH).toBe('1')
    expect(job.strategy.matrix.include).toEqual([
      { os: 'ubuntu-22.04', arch: 'x64', unpacked_dir: 'dist/linux-unpacked' },
      { os: 'ubuntu-24.04-arm', arch: 'arm64', unpacked_dir: 'dist/linux-arm64-unpacked' }
    ])
    const steps = job.steps
    const packageStep = steps.find((step) => step.name === 'Package without release publication')
    expect(packageStep.run).toContain('--linux AppImage deb rpm --"$PACKAGE_ARCH" --publish never')
    expect(packageStep.run).not.toContain('--publish always')
    const gate = steps.find(
      (step) => step.name === 'Qualify packaged terminal on Ubuntu 20.04 userspace'
    )
    expect(gate.run).toContain('set -euo pipefail')
    expect(gate.run).toContain(
      'run-linux-packaged-terminal-floor-smoke.mjs --app-dir "$PACKAGE_DIRECTORY"'
    )
    expect(gate.run).toContain('floor-smoke.log')
    const evidence = steps.find((step) => step.name === 'Preserve exact package and provenance')
    expect(evidence.run).toContain('git rev-parse HEAD')
    expect(evidence.run).toContain('payload-sha256.txt')
    expect(evidence.run).toContain('unpacked-$PACKAGE_ARCH.tar.gz')
    expect(steps.indexOf(evidence)).toBeGreaterThan(steps.indexOf(packageStep))
    expect(steps.indexOf(evidence)).toBeLessThan(steps.indexOf(gate))
    const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact'))
    expect(upload.if).toBe('${{ always() }}')
    expect(upload.with.path).toContain('linux-package-evidence/')
    expect(upload.with.path).toContain('dist/*.AppImage')
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(gate))
  })
  it('runs the exact packaged terminal on both release architectures before upload', () => {
    const workflow = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
    const steps = workflow.jobs.build.steps
    const gate = steps.find(
      (step) => step.name === 'Qualify packaged Bun terminal on the Linux floor'
    )
    expect(gate.if).toContain("matrix.platform == 'linux-x64'")
    expect(gate.if).toContain("matrix.platform == 'linux-arm64'")
    expect(gate.with.command).toContain('run-linux-packaged-terminal-floor-smoke.mjs')
    expect(gate.with.command).toContain('${{ matrix.unpacked_dir }}')
    expect(steps.indexOf(gate)).toBeLessThan(
      steps.findIndex((step) => step.uses?.startsWith('actions/upload-artifact'))
    )
    expect(
      packagedTerminalFloorDockerArgs({
        appDirectory: '/app',
        fixtureDirectory: '/gate',
        containerName: 'owned-probe'
      })
    ).toContain('owned-probe')
  })
})
