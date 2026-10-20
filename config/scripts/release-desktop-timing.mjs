import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function timestamp(value, label) {
  const result = Date.parse(value)
  assert(Number.isFinite(result), `Missing or invalid ${label}`)
  return result
}

function startedStep(job) {
  const starts = job.steps
    .filter((step) => step.status !== 'skipped' && step.conclusion !== 'skipped')
    .map((step) => Date.parse(step.startedAt ?? step.started_at))
    .filter(Number.isFinite)
  assert(starts.length > 0, `No started steps for ${job.name}`)
  return Math.min(...starts)
}

function interval(job) {
  const start = startedStep(job)
  const end = timestamp(job.completedAt ?? job.completed_at, `${job.name} completion`)
  assert(end >= start, `Completion precedes first step for ${job.name}`)
  return { start, end }
}

function seconds(milliseconds) {
  return Math.round(milliseconds) / 1000
}

function phaseSteps(jobs, pattern) {
  const matches = jobs.flatMap((job) =>
    job.steps
      .filter((step) => step.conclusion === 'success' && pattern.test(step.name))
      .map((step) => ({
        job: job.name,
        step: step.name,
        seconds: seconds(
          timestamp(step.completedAt ?? step.completed_at, `${step.name} completion`) -
            timestamp(step.startedAt ?? step.started_at, `${step.name} start`)
        )
      }))
  )
  return {
    seconds: matches.length ? matches.reduce((sum, step) => sum + step.seconds, 0) : null,
    steps: matches
  }
}

function overlapSeconds(mac, windows) {
  const segments = windows
    .map((win) => ({ start: Math.max(mac.start, win.start), end: Math.min(mac.end, win.end) }))
    .filter(({ start, end }) => start < end)
    .sort((left, right) => left.start - right.start)
  const merged = []
  for (const segment of segments) {
    const previous = merged.at(-1)
    if (previous && previous.end >= segment.start) {
      previous.end = Math.max(previous.end, segment.end)
    } else {
      merged.push({ ...segment })
    }
  }
  return seconds(merged.reduce((sum, { start, end }) => sum + end - start, 0))
}

export function summarizeReleaseDesktopTiming(run) {
  assert(
    run.status === 'completed' && run.conclusion === 'success',
    'Require a completed successful run'
  )
  const jobs = run.jobs.filter((job) => job.conclusion !== 'skipped')
  const mac = jobs.find((job) => job.name === 'build-adhoc-mac')
  const windows = jobs.filter((job) => /^(?:build|stage|publish)-adhoc-win(?:\b|\/)/.test(job.name))
  const template = jobs.find((job) => job.name === 'orcad-template / desktop_template')
  assert(mac && windows.length > 0 && template, 'Missing Mac, Windows, or qualified template job')
  assert(
    [mac, ...windows, template].every((job) => job.conclusion === 'success'),
    'Desktop or template job failed'
  )
  const qualification = jobs.filter((job) => job.name.startsWith('orcad-template / '))
  const macInterval = interval(mac)
  const windowsIntervals = windows.map(interval)
  const desktopStart = Math.min(macInterval.start, ...windowsIntervals.map(({ start }) => start))
  const desktopEnd = Math.max(macInterval.end, ...windowsIntervals.map(({ end }) => end))
  const created = timestamp(run.createdAt ?? run.created_at, 'run creation')
  const templateEnd = interval(template).end
  return {
    source: { url: run.url ?? run.html_url ?? null, headSha: run.headSha ?? run.head_sha ?? null },
    measuredSeconds: {
      creationToLastJob: seconds(Math.max(...jobs.map((job) => interval(job).end)) - created),
      qualification: seconds(templateEnd - Math.min(...qualification.map(startedStep))),
      desktop: seconds(desktopEnd - desktopStart),
      macJob: seconds(macInterval.end - macInterval.start),
      windowsJobTotal: seconds(
        windowsIntervals.reduce((sum, { start, end }) => sum + end - start, 0)
      ),
      desktopJobOverlap: overlapSeconds(macInterval, windowsIntervals),
      templateReadyToMacFirstStep: seconds(macInterval.start - templateEnd),
      templateReadyToWindowsFirstStep: seconds(
        Math.min(...windowsIntervals.map(({ start }) => start)) - templateEnd
      )
    },
    windowsPhases: {
      dependencies: phaseSteps(windows, /^Install dependencies$/),
      appBuild: phaseSteps(windows, /^Build app$/),
      packagingAndUpload: phaseSteps(
        windows,
        /^(?:Package Windows artifacts(?: without publishing)?|Publish Windows artifacts)$/
      ),
      artifactHandoff: phaseSteps(
        windows,
        /^(?:Stage Windows artifacts for gated publishing|Download the staged Windows artifacts)$/
      )
    },
    desktopJobs: [mac, ...windows].map((job) => {
      const { start, end } = interval(job)
      return {
        name: job.name,
        firstStepAt: new Date(start).toISOString(),
        completedAt: new Date(end).toISOString(),
        reportedStartToFirstStepSeconds: seconds(
          start - timestamp(job.startedAt ?? job.started_at, `${job.name} reported start`)
        )
      }
    })
  }
}

export function compareReleaseDesktopTiming(baseline, candidate) {
  const before = summarizeReleaseDesktopTiming(baseline)
  const after = summarizeReleaseDesktopTiming(candidate)
  return {
    methodology: [
      'Measured timestamps from two successful GitHub Actions runs; no modeled speedup.',
      'Job intervals begin at the first started step, not the reported job start.',
      'Creation-to-last-job includes scheduling and runner waits; desktop includes teardown and publication.',
      'Template-to-first-step gaps include dependency scheduling and runner waits, not queue time alone.',
      'Overlap is the union of Windows job intervals intersecting the Mac job, including setup and teardown.',
      'Different source commits, caches, and runner load can affect a two-run comparison.'
    ],
    baseline: before,
    candidate: after,
    measuredSavingsSeconds: Object.fromEntries(
      Object.entries(before.measuredSeconds).map(([key, value]) => [
        key,
        seconds((value - after.measuredSeconds[key]) * 1000)
      ])
    )
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baselineFile, candidateFile, outputFile] = process.argv.slice(2)
  assert(
    baselineFile && candidateFile && process.argv.length <= 5,
    'Usage: node config/scripts/release-desktop-timing.mjs baseline.json candidate.json [report.json]'
  )
  const report = compareReleaseDesktopTiming(
    JSON.parse(readFileSync(baselineFile, 'utf8')),
    JSON.parse(readFileSync(candidateFile, 'utf8'))
  )
  const json = `${JSON.stringify(report, null, 2)}\n`
  if (outputFile) {
    writeFileSync(outputFile, json)
  }
  process.stdout.write(json)
}
