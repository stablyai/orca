import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const packageJson = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8'))

describe('Electron release workflow contract', () => {
  it('keeps platform golden regressions in the manual and release workflows', () => {
    const packageScripts = packageJson.scripts
    const goldenWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/golden-e2e-experiment.yml'), 'utf8')
    )
    const releaseWorkflow = parse(
      readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')
    )
    const steps = goldenWorkflow.jobs['golden-e2e'].steps
    const goldenPlatformLabels = new Map([
      ['linux', 'Linux'],
      ['mac', 'macOS'],
      ['windows', 'Windows']
    ])
    const goldenMatrix = goldenWorkflow.jobs['golden-e2e'].strategy.matrix.include
    const goldenPlatforms = goldenMatrix.map(({ platform }) => platform).sort()
    const goldenRunSteps = new Map(
      goldenPlatforms.map((platform) => {
        const label = goldenPlatformLabels.get(platform)

        expect(label, platform).toBeDefined()

        return [platform, steps.find((step) => step.name === `Run golden E2E tests on ${label}`)]
      })
    )
    const releaseGoldenJob = releaseWorkflow.jobs['terminal-rendering-golden']
    const releaseGoldenMatrix = releaseGoldenJob.strategy.matrix.include
    const releaseEvidenceJob = releaseWorkflow.jobs['terminal-rendering-release-evidence']
    const releaseBuildNeeds = releaseWorkflow.jobs.build.needs
    const publishReleaseNeeds = releaseWorkflow.jobs['publish-release'].needs
    // Why: Windows release evidence is temporarily paused for CI runner PTY readiness.
    const releaseEvidencePlatforms = ['linux', 'mac']

    expect(packageScripts['test:e2e:terminal-rendering-golden']).toContain(
      '@terminal-rendering-golden'
    )
    expect(packageScripts['test:e2e:terminal-rendering-golden']).toContain(
      'terminal-raw-emoji-table-scroll-restore.spec.ts'
    )
    expect(packageScripts['test:e2e:terminal-rendering-golden']).toContain(
      'terminal-webgl-atlas-budget.spec.ts'
    )
    expect(packageScripts['test:e2e:terminal-rendering-golden']).not.toContain(
      'terminal-long-table-scroll-restore.spec.ts'
    )
    const goldenCommand = packageScripts['test:e2e:terminal-rendering-golden']
    expect(goldenCommand).toContain('--project electron-headless')
    expect(goldenCommand).toContain('--project electron-headful')
    expect(packageScripts['test:e2e:windows-fresh-startup-golden']).toContain(
      'golden-windows-fresh-startup.spec.ts'
    )
    expect(packageScripts['test:e2e:windows-fresh-startup-golden']).toContain(
      '@windows-fresh-startup-golden'
    )
    expect(packageScripts['test:e2e:posix-profile-index-golden']).toContain(
      'golden-posix-profile-index-fsync.spec.ts'
    )
    expect(packageScripts['test:e2e:posix-profile-index-golden']).toContain(
      'golden-posix-fresh-startup.spec.ts'
    )
    expect(packageScripts['test:e2e:posix-profile-index-golden']).toContain(
      '@posix-profile-index-golden'
    )
    expect(packageScripts['test:e2e:terminal-rendering-release-evidence']).toContain(
      'terminal-opencode-emoji-table-rendering.spec.ts'
    )
    expect(packageScripts['test:e2e:terminal-rendering-release-evidence']).toContain(
      'terminal-long-table-scroll-restore.spec.ts'
    )
    expect(goldenMatrix).toEqual([
      { os: 'ubuntu-latest', platform: 'linux' },
      { os: 'macos-15', platform: 'mac' },
      { os: 'windows-2022', platform: 'windows' }
    ])
    expect(goldenRunSteps.get('linux')?.run).toContain(
      'pnpm run test:e2e:terminal-rendering-golden'
    )
    expect(goldenRunSteps.get('linux')?.run).toContain(
      'pnpm run --if-present test:e2e:posix-profile-index-golden'
    )
    expect(goldenRunSteps.get('mac')?.run).toContain('pnpm run test:e2e:terminal-rendering-golden')
    expect(goldenRunSteps.get('mac')?.run).toContain(
      'pnpm run --if-present test:e2e:posix-profile-index-golden'
    )
    expect(goldenRunSteps.get('windows')).toMatchObject({
      if: "runner.os == 'Windows'",
      shell: 'pwsh'
    })
    expect(goldenRunSteps.get('windows').run).toContain(
      'pnpm run --if-present test:e2e:windows-fresh-startup-golden'
    )
    expect(goldenWorkflow.on.pull_request).toBeUndefined()
    expect(goldenWorkflow.on.workflow_dispatch).toBeDefined()
    expect(releaseBuildNeeds).not.toContain('terminal-rendering-golden')
    expect(releaseBuildNeeds).not.toContain('terminal-rendering-release-evidence')
    expect(publishReleaseNeeds).toContain('terminal-rendering-golden')
    expect(publishReleaseNeeds).toContain('build')
    expect(publishReleaseNeeds).not.toContain('terminal-rendering-release-evidence')
    expect(releaseGoldenJob['continue-on-error']).toBeUndefined()
    expect(releaseGoldenMatrix).toEqual(goldenMatrix)
    const releaseLinuxRunStep = releaseGoldenJob.steps.find(
      (step) => step.name === 'Run terminal rendering golden on Linux'
    )
    expect(releaseLinuxRunStep.run).toContain('pnpm run test:e2e:terminal-rendering-golden')
    expect(releaseLinuxRunStep.run).toContain(
      'pnpm run --if-present test:e2e:posix-profile-index-golden'
    )
    const releaseMacRunStep = releaseGoldenJob.steps.find(
      (step) => step.name === 'Run terminal rendering golden on macOS'
    )
    expect(releaseMacRunStep.run).toContain('pnpm run test:e2e:terminal-rendering-golden')
    expect(releaseMacRunStep.run).toContain(
      'pnpm run --if-present test:e2e:posix-profile-index-golden'
    )
    const releaseWindowsRunStep = releaseGoldenJob.steps.find(
      (step) => step.name === 'Run fresh-startup golden on Windows'
    )
    expect(releaseWindowsRunStep).toMatchObject({
      if: "runner.os == 'Windows'",
      shell: 'pwsh'
    })
    expect(releaseWindowsRunStep.run).toContain(
      'pnpm run --if-present test:e2e:windows-fresh-startup-golden'
    )
    expect(releaseWindowsRunStep.run).not.toContain('test:e2e:workspace-session-golden')
    expect(releaseWindowsRunStep.run).not.toContain('test:e2e:source-control-golden')
    expect(releaseEvidenceJob['continue-on-error']).toBe(true)
    expect(
      releaseEvidenceJob.strategy.matrix.include.map(({ platform }) => platform).sort()
    ).toEqual(releaseEvidencePlatforms)
    expect(releaseEvidenceJob.steps.map((step) => step.run ?? '')).toContain(
      'xvfb-run --auto-servernum env SKIP_BUILD=1 ORCA_E2E_FORWARD_APP_LOGS=1 pnpm run test:e2e:terminal-rendering-release-evidence'
    )
  })
})
