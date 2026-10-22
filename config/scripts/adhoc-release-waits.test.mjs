import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const adhoc = parse(readFileSync('.github/workflows/adhoc-mac-build.yml', 'utf8'))
const publisher = parse(readFileSync('.github/workflows/dev-channel-win-publish.yml', 'utf8'))
const windows = parse(readFileSync('.github/workflows/dev-channel-win-build.yml', 'utf8'))
const macSteps = adhoc.jobs['build-adhoc-mac-arch'].steps
const finalSteps = adhoc.jobs['build-adhoc-mac'].steps
const publishSteps = publisher.jobs['publish-win'].steps
const macWait = publishSteps.find((step) => step.name === 'Wait for successful macOS publication')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

function execute(step, snapshots) {
  let now = 0
  let snapshot = 0
  const calls = []
  const github = {
    rest: { actions: { listJobsForWorkflowRun: 'jobs', listWorkflowRunArtifacts: 'artifacts' } },
    paginate: vi.fn(async (endpoint, input) => {
      calls.push({ endpoint, input })
      const current = snapshots[Math.min(snapshot, snapshots.length - 1)]
      return current[endpoint] ?? []
    })
  }
  const run = new AsyncFunction(
    'github',
    'context',
    'process',
    'Date',
    'setTimeout',
    step.with.script
  )
  return {
    calls,
    result: run(
      github,
      { repo: { owner: 'owner', repo: 'repo' }, runId: 42 },
      { env: { ...step.env, MAC_JOB: 'build-adhoc-mac' } },
      { now: () => now },
      (resolve) => {
        now += 15_000
        snapshot++
        resolve()
      }
    )
  }
}

const job = (name, conclusion) => ({
  name,
  status: conclusion ? 'completed' : 'in_progress',
  conclusion
})

describe.each([
  ['Mac', macSteps],
  ['Windows', windows.jobs['build-win'].steps]
])('%s release waits retain qualification and publication gates', (_platform, buildSteps) => {
  const templateWait = buildSteps.find(
    (step) => step.name === 'Wait for the qualified orcad template'
  )
  it('allows desktop setup first, but waits for a qualified artifact from this run', async () => {
    const { result, calls } = execute(templateWait, [
      { jobs: [job('orcad-template / cache', 'success')] },
      { jobs: [job('orcad-template / qualify / persistence (windows-11-arm)')] },
      { artifacts: [{ name: 'orcad-template', expired: true }] },
      { artifacts: [{ name: 'orcad-template', expired: false }] }
    ])
    await result
    expect(calls.filter((call) => call.endpoint === 'artifacts')).toHaveLength(4)
    expect(calls.every((call) => call.input.run_id === 42)).toBe(true)
    expect(buildSteps.indexOf(templateWait)).toBeGreaterThan(
      buildSteps.findIndex((step) => step.name === 'Build app')
    )
    expect(buildSteps.indexOf(templateWait)).toBeLessThan(
      buildSteps.findIndex((step) => step.name === 'Download the orcad deployment template')
    )
  })

  it.each(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure'])(
    'refuses to package after template qualification ends with %s',
    async (conclusion) => {
      await expect(
        execute(templateWait, [
          {
            jobs: [job('orcad-template / qualify / persistence (windows-11-arm)', conclusion)],
            artifacts: [{ name: 'orcad-template', expired: false }]
          }
        ]).result
      ).rejects.toThrow('Template qualification failed')
    }
  )

  it('times out when no qualified artifact is produced', async () => {
    await expect(execute(templateWait, [{}]).result).rejects.toThrow('Timed out')
  })

  it('prefetches Windows assets before waiting, then mints credentials after Mac succeeds', async () => {
    const download = publishSteps.findIndex(
      (step) => step.name === 'Download the staged Windows artifacts'
    )
    const wait = publishSteps.indexOf(macWait)
    const token = publishSteps.findIndex((step) => step.name === 'Mint dev channel repo token')
    expect(download).toBeLessThan(wait)
    expect(wait).toBeLessThan(token)
    await execute(macWait, [
      { jobs: [job('build-adhoc-mac')] },
      { jobs: [job('build-adhoc-mac', 'success')] }
    ]).result
  })

  it.each(['failure', 'cancelled', 'skipped', 'timed_out'])(
    'refuses Windows publication when Mac ends with %s',
    async (conclusion) => {
      await expect(
        execute(macWait, [{ jobs: [job('build-adhoc-mac', conclusion)] }]).result
      ).rejects.toThrow('macOS publication did not succeed')
    }
  )
})

it('keeps the release a draft until qualification and its cleanup finish', async () => {
  const final = finalSteps.find(
    (step) => step.name === 'Confirm final template qualification before publication'
  )
  const artifact = [{ name: 'orcad-template', expired: false }]
  const { result, calls } = execute(final, [
    { artifacts: artifact, jobs: [job('orcad-template / qualify / desktop_template')] },
    { artifacts: artifact, jobs: [job('orcad-template / qualify / desktop_template', 'success')] }
  ])
  await result
  expect(calls.filter((call) => call.endpoint === 'artifacts')).toHaveLength(2)
  expect(finalSteps.indexOf(final)).toBeLessThan(
    finalSteps.findIndex((step) => step.id === 'publish_live')
  )
})

it('uses the same qualification wait on both platforms', () => {
  const script = (steps) =>
    steps.find((step) => step.name === 'Wait for the qualified orcad template').with.script
  expect(script(windows.jobs['build-win'].steps)).toBe(script(macSteps))
})
