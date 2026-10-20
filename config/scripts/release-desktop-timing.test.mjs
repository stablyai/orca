import { describe, expect, it } from 'vitest'
import {
  compareReleaseDesktopTiming,
  summarizeReleaseDesktopTiming
} from './release-desktop-timing.mjs'

const at = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString()

function job(name, start, end, firstStep = start, steps = []) {
  return {
    name,
    conclusion: 'success',
    startedAt: at(start),
    completedAt: at(end),
    steps: [
      {
        name: 'Set up job',
        conclusion: 'success',
        startedAt: at(firstStep),
        completedAt: at(firstStep + 1)
      },
      ...steps
    ]
  }
}

function run(windows, macStart = 20, macEnd = 100) {
  return {
    status: 'completed',
    conclusion: 'success',
    createdAt: at(0),
    jobs: [
      job('orcad-template-support', 2, 3),
      job('orcad-template / desktop_template', 3, 10),
      job('build-adhoc-mac', macStart, macEnd),
      ...windows
    ]
  }
}

describe('release desktop timing evidence', () => {
  it('measures the sequential baseline and actual candidate overlap without counting queue timestamps as execution', () => {
    const baseline = run([job('build-adhoc-win / build-win', 100, 160, 110)])
    const candidate = run([
      job('build-adhoc-win / build-win', 10, 75, 25),
      job('publish-adhoc-win / publish-win', 100, 110, 101)
    ])
    const report = compareReleaseDesktopTiming(baseline, candidate)
    expect(report.baseline.measuredSeconds.desktopJobOverlap).toBe(0)
    expect(report.candidate.measuredSeconds.desktopJobOverlap).toBe(50)
    expect(report.candidate.measuredSeconds.desktop).toBe(90)
    expect(report.measuredSavingsSeconds.desktop).toBe(50)
    expect(report.candidate.desktopJobs[1].reportedStartToFirstStepSeconds).toBe(15)
    expect(report.candidate.measuredSeconds.templateReadyToWindowsFirstStep).toBe(15)
  })

  it('unions intersecting Windows intervals and ignores skipped jobs and skipped step timestamps', () => {
    const windows = job('build-adhoc-win / build-win', 10, 80, 30)
    windows.steps.unshift({ name: 'Skipped', conclusion: 'skipped', startedAt: at(10) })
    const input = run([windows, job('publish-adhoc-win / publish-win', 70, 90)])
    input.jobs.push({ name: 'build-adhoc-win-old', conclusion: 'skipped', steps: [] })
    const report = summarizeReleaseDesktopTiming(input)
    expect(report.measuredSeconds.desktopJobOverlap).toBe(60)
    expect(report.measuredSeconds.windowsJobTotal).toBe(70)
  })

  it('retains measured step evidence and leaves missing phases unknown', () => {
    const input = run([
      job('build-adhoc-win / build-win', 100, 170, 100, [
        { name: 'Build app', conclusion: 'success', startedAt: at(101), completedAt: at(131) },
        {
          name: 'Publish Windows artifacts',
          conclusion: 'success',
          startedAt: at(131),
          completedAt: at(160)
        }
      ])
    ])
    const report = summarizeReleaseDesktopTiming(input)
    expect(report.windowsPhases.appBuild.seconds).toBe(30)
    expect(report.windowsPhases.packagingAndUpload.seconds).toBe(29)
    expect(report.windowsPhases.dependencies.seconds).toBeNull()
    expect(report.windowsPhases.appBuild.steps[0].job).toBe('build-adhoc-win / build-win')
  })

  it('accounts for packaging and the extra artifact handoff in a split Windows build', () => {
    const step = (name, start, end) => ({
      name,
      conclusion: 'success',
      startedAt: at(start),
      completedAt: at(end)
    })
    const report = summarizeReleaseDesktopTiming(
      run([
        job('stage-adhoc-win / build-win', 20, 80, 20, [
          step('Package Windows artifacts without publishing', 30, 60),
          step('Stage Windows artifacts for gated publishing', 60, 70)
        ]),
        job('publish-adhoc-win / publish-win', 100, 130, 100, [
          step('Download the staged Windows artifacts', 101, 111),
          step('Publish Windows artifacts', 111, 125)
        ])
      ])
    )
    expect(report.windowsPhases.packagingAndUpload.seconds).toBe(44)
    expect(report.windowsPhases.artifactHandoff.seconds).toBe(20)
  })

  it('rejects incomplete runs, failed desktop jobs, and missing timing evidence', () => {
    const input = run([job('build-adhoc-win / build-win', 100, 160)])
    expect(() => summarizeReleaseDesktopTiming({ ...input, status: 'in_progress' })).toThrow(
      'completed successful run'
    )
    input.jobs.at(-1).conclusion = 'failure'
    expect(() => summarizeReleaseDesktopTiming(input)).toThrow('Desktop or template job failed')
    input.jobs.at(-1).conclusion = 'success'
    input.jobs.at(-1).steps = []
    expect(() => summarizeReleaseDesktopTiming(input)).toThrow('No started steps')
  })
})
