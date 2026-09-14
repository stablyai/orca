import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/release-cut.yml', 'utf8'))
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))

function stepNamed(job, name) {
  return job.steps.find((step) => step.name === name)
}

describe('skill-sharing release workflow', () => {
  it('keeps artifact builds behind every blocking release gate', () => {
    const preflight = workflow.jobs['release-preflight']
    const build = workflow.jobs.build
    const macBuild = workflow.jobs['build-mac']

    expect(preflight.needs).toEqual([
      'cut',
      'terminal-rendering-golden',
      'skill-sharing-release-gate',
      'skill-sharing-linux-floor-release-gate'
    ])
    expect(preflight.if).toContain('always()')
    expect(preflight.if).toContain("needs.terminal-rendering-golden.result == 'success'")
    expect(preflight.if).toContain("needs.skill-sharing-release-gate.result == 'success'")
    expect(preflight.if).toContain(
      "needs.skill-sharing-linux-floor-release-gate.result == 'success'"
    )
    expect(build.needs).toContain('release-preflight')
    expect(macBuild.needs).toContain('release-preflight')
  })

  it('blocks on macOS and the Linux floor while keeping Windows diagnostic', () => {
    const platform = workflow.jobs['skill-sharing-release-gate']
    const linux = workflow.jobs['skill-sharing-linux-floor-release-gate']
    const publishNeeds = workflow.jobs['publish-release'].needs

    expect(platform.strategy.matrix.include).toEqual([
      { os: 'macos-15', platform: 'mac' },
      { os: 'windows-2022', platform: 'windows' }
    ])
    expect(platform['continue-on-error']).toBe("${{ matrix.platform == 'windows' }}")
    expect(linux.container).toBe('ubuntu:20.04')
    expect(publishNeeds).toContain('skill-sharing-release-gate')
    expect(publishNeeds).toContain('skill-sharing-linux-floor-release-gate')
  })

  it('runs the focused contract and transaction suite with real Windows coverage', () => {
    const platform = workflow.jobs['skill-sharing-release-gate']
    const linux = workflow.jobs['skill-sharing-linux-floor-release-gate']
    const platformTest = stepNamed(
      platform,
      'Run skill package, transaction, and compatibility suites'
    )
    const linuxTest = stepNamed(linux, 'Run skill package, transaction, and compatibility suites')
    const command = packageJson.scripts['test:skill-sharing:release']

    expect(platformTest.env.ORCA_REAL_WINDOWS_SKILL_TEST).toContain("runner.os == 'Windows'")
    expect(platformTest.env.ORCA_REAL_PROCESS_SKILL_TEST).toBe('1')
    expect(linuxTest.env.ORCA_REAL_PROCESS_SKILL_TEST).toBe('1')
    expect(platformTest.run).toContain('pnpm test:skill-sharing:release')
    expect(linuxTest.run).toContain('pnpm test:skill-sharing:release')
    expect(command).toContain('src/main/skills')
    expect(command).toContain('src/relay/skill-install-handler.test.ts')
    expect(command).toContain('src/shared/skill-bundle-install-contract.test.ts')
  })

  it('installs the archive tool required by Electron on the Linux floor', () => {
    const linux = workflow.jobs['skill-sharing-linux-floor-release-gate']
    const prerequisites = stepNamed(linux, 'Install Ubuntu 20.04 prerequisites')

    expect(prerequisites.run).toMatch(/apt-get install[^\n]*\bunzip\b/)
  })

  it('trusts only the checked-out workspace before container git operations', () => {
    const linux = workflow.jobs['skill-sharing-linux-floor-release-gate']
    const trustWorkspace = stepNamed(linux, 'Trust the checked-out workspace in the job container')
    const restoreHarness = stepNamed(
      linux,
      'Restore skill-sharing test harness from the workflow ref'
    )
    const safeDirectoryCommands = linux.steps
      .filter((step) => typeof step.run === 'string' && step.run.includes('safe.directory'))
      .map((step) => step.run)

    expect(trustWorkspace.run).toBe('git config --global --add safe.directory "$GITHUB_WORKSPACE"')
    expect(linux.steps.indexOf(trustWorkspace)).toBeLessThan(linux.steps.indexOf(restoreHarness))
    expect(safeDirectoryCommands).toEqual([
      'git config --global --add safe.directory "$GITHUB_WORKSPACE"'
    ])
  })

  it('validates immutable tags with the current skill-sharing test harness', () => {
    for (const jobName of [
      'skill-sharing-release-gate',
      'skill-sharing-linux-floor-release-gate'
    ]) {
      const restore = stepNamed(
        workflow.jobs[jobName],
        'Restore skill-sharing test harness from the workflow ref'
      )

      expect(restore.env.WORKFLOW_SHA).toBe('${{ github.workflow_sha }}')
      expect(restore.run).toContain('git fetch --no-tags --depth=1 origin "$WORKFLOW_SHA"')
      expect(restore.run).toContain('skill-freshness-inventory.test.ts')
      expect(restore.run).toContain('skill-provider-runtime-roots.test.ts')
    }
  })

  it('archives bounded machine-readable evidence from every platform', () => {
    for (const jobName of [
      'skill-sharing-release-gate',
      'skill-sharing-linux-floor-release-gate'
    ]) {
      const job = workflow.jobs[jobName]
      const test = stepNamed(job, 'Run skill package, transaction, and compatibility suites')
      const archive = stepNamed(job, 'Archive bounded skill-sharing results')

      expect(test.run).toContain('--reporter=json')
      expect(test.run).toContain('--outputFile=skill-sharing-release-results.json')
      expect(archive.if).toBe('always()')
      expect(archive.with['retention-days']).toBe(14)
      expect(archive.with['if-no-files-found']).toBe('error')
    }
  })

  it('loads each exact Linux package on the glibc 2.31 floor', () => {
    const build = workflow.jobs.build
    const smoke = stepNamed(build, 'Load packaged node-pty on the Linux floor')
    const linuxEntries = build.strategy.matrix.include.filter(({ platform }) =>
      platform.startsWith('linux-')
    )

    expect(linuxEntries).toEqual([
      expect.objectContaining({ platform: 'linux-x64', unpacked_dir: 'dist/linux-unpacked' }),
      expect.objectContaining({
        platform: 'linux-arm64',
        unpacked_dir: 'dist/linux-arm64-unpacked'
      })
    ])
    expect(smoke.if).toContain("matrix.platform == 'linux-x64'")
    expect(smoke.with.command).toContain('run-linux-packaged-node-pty-floor-smoke.mjs')
    expect(smoke.with.command).toContain('${{ matrix.unpacked_dir }}')
  })
})
