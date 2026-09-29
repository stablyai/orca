import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

describe('computer-use e2e workflow', () => {
  it('uses the cached Electron dependency path for scheduled Linux and Windows e2e', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    for (const jobName of ['linux', 'windows']) {
      const job = workflow.jobs[jobName]
      const checkout = job.steps.find((step) => step.uses === 'actions/checkout@v6')
      const install = job.steps.find(
        (step) => step.uses === './.github/actions/install-node-dependencies'
      )
      expect(checkout.with['persist-credentials'], jobName).toBe(false)
      expect(install.with['native-runtime'], jobName).toBe('electron')
      expect(
        job.steps.some((step) => step.uses === 'pnpm/setup@v2'),
        jobName
      ).toBe(false)
      expect(
        job.steps.some((step) => step.run === 'pnpm install --frozen-lockfile'),
        jobName
      ).toBe(false)
    }
  })

  it('boots the built daemon under plain Node in the PR native-smoke job after the main build', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const steps = workflow.jobs['native-smoke'].steps
    const runs = steps.map((step) => step.run).filter((run) => typeof run === 'string')
    const buildIndex = runs.indexOf('pnpm run build:electron-vite:parallel')
    const daemonSmokeIndex = runs.indexOf('node config/scripts/daemon-boot-smoke.mjs')

    expect(daemonSmokeIndex, 'native-smoke must boot the built daemon').toBeGreaterThanOrEqual(0)
    expect(
      buildIndex,
      'daemon boot smoke must run after the main bundle is built'
    ).toBeGreaterThanOrEqual(0)
    expect(daemonSmokeIndex).toBeGreaterThan(buildIndex)
  })

  it('runs the Windows workspace-close daemon repro after the main build', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const steps = workflow.jobs['native-smoke'].steps
    const buildIndex = steps.findIndex(
      (step) => step.run === 'pnpm run build:electron-vite:parallel'
    )
    const reproIndex = steps.findIndex(
      (step) => step.run === 'node config/scripts/windows-daemon-workspace-close-repro.mjs'
    )

    expect(reproIndex).toBeGreaterThan(buildIndex)
    expect(steps[reproIndex].if).toBe("runner.os == 'Windows'")
    expect(workflow.on.pull_request.paths).toContain(
      'config/scripts/windows-daemon-workspace-close-repro.mjs'
    )
  })

  it('builds Electron main output before every computer-use e2e run', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )

    for (const jobName of ['native-smoke', 'linux', 'windows']) {
      const runs = workflow.jobs[jobName].steps
        .map((step) => step.run)
        .filter((run) => typeof run === 'string')
      const buildIndex = runs.indexOf('pnpm run build:electron-vite:parallel')
      const e2eIndexes = runs
        .map((run, index) => (run.includes('test:e2e:computer') ? index : -1))
        .filter((index) => index >= 0)

      expect(
        buildIndex,
        `${jobName} should build out/main before computer e2e`
      ).toBeGreaterThanOrEqual(0)
      for (const e2eIndex of e2eIndexes) {
        expect(buildIndex, `${jobName} should build out/main before computer e2e`).toBeLessThan(
          e2eIndex
        )
      }
    }
  })

  it('keeps computer-use e2e in scheduled jobs only', () => {
    const workflow = parse(
      readFileSync(join(projectDir, '.github/workflows/computer-e2e.yml'), 'utf8')
    )
    const nativeSmokeRuns = workflow.jobs['native-smoke'].steps
      .map((step) => step.run)
      .filter((run) => typeof run === 'string')
    const allRuns = [
      ...nativeSmokeRuns,
      ...workflow.jobs.linux.steps.map((step) => step.run).filter((run) => typeof run === 'string'),
      ...workflow.jobs.windows.steps
        .map((step) => step.run)
        .filter((run) => typeof run === 'string')
    ]

    expect(nativeSmokeRuns.join('\n')).not.toContain('test:e2e:computer')
    expect(allRuns.join('\n')).toContain('test:e2e:computer')
    expect(allRuns.join('\n')).not.toContain('test:e2e:computer -- --reporter')
  })
})
