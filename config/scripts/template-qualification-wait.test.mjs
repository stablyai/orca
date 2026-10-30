import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const { jobs } = parse(readFileSync('.github/workflows/node-server-tests.yml', 'utf8'))
const step = jobs.desktop_template.steps.find(
  (item) => item.name === 'Wait for every template qualification lane'
)
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
function lanes(prefix = 'orcad-template / qualify / ') {
  return [
    { name: `${prefix}desktop_template`, status: 'in_progress' },
    ...Object.entries({
      persistence: 6,
      mobile_web_bundle: 1,
      linux_glibc_floor: 2,
      linux_glibc217_compat: 1,
      linux_musl: 2
    }).flatMap(([name, count]) =>
      Array.from({ length: count }, (_, i) => ({
        name: `${prefix}${name}${count > 1 ? ` (platform-${i})` : ''}`,
        status: 'completed',
        conclusion: 'success'
      }))
    )
  ]
}
function execute(snapshots) {
  let now = 0
  let index = 0
  const calls = []
  const delays = []
  const github = {
    rest: { actions: { listJobsForWorkflowRun: 'jobs' } },
    async paginate(endpoint, input) {
      calls.push({ endpoint, input })
      return snapshots[Math.min(index, snapshots.length - 1)]
    }
  }
  return {
    calls,
    delays,
    result: new AsyncFunction('github', 'context', 'Date', 'setTimeout', step.with.script)(
      github,
      { repo: { owner: 'owner', repo: 'repo' }, runId: 42 },
      { now: () => now },
      (resolve, delay) => {
        delays.push(delay)
        now += delay
        index++
        resolve()
      }
    )
  }
}

describe('early template assembly qualification gate', () => {
  it.each(['', 'orcad-template / qualify / '])(
    'waits for all current-attempt jobs with prefix %s',
    async (prefix) => {
      const incomplete = lanes(prefix)
      incomplete[1] = { ...incomplete[1], status: 'in_progress', conclusion: null }
      const { calls, delays, result } = execute([incomplete, lanes(prefix)])
      await result
      expect(calls).toHaveLength(2)
      expect(delays).toEqual([15_000])
      for (const { endpoint, input } of calls) {
        expect(endpoint).toBe('jobs')
        expect(input).toMatchObject({
          owner: 'owner',
          repo: 'repo',
          filter: 'latest',
          run_id: 42
        })
      }
    }
  )
  it.each(['failure', 'cancelled', 'skipped', 'timed_out', 'action_required', 'startup_failure'])(
    'rejects %s from any lane',
    async (conclusion) => {
      for (let i = 1; i < lanes().length; i++) {
        const input = lanes()
        input[i].conclusion = conclusion
        await expect(execute([input]).result).rejects.toThrow('qualification did not succeed')
      }
    }
  )
  it('fails closed for missing, extra, ambiguous and unrelated jobs', async () => {
    await expect(execute([lanes().slice(0, -1)]).result).rejects.toThrow('Timed out')
    await expect(
      execute([[...lanes(), { ...lanes()[1], name: `${lanes()[1].name}-extra` }]]).result
    ).rejects.toThrow('Unexpected')
    await expect(execute([[...lanes(), ...lanes('other / ')]]).result).rejects.toThrow('Ambiguous')
    await expect(
      execute([
        [{ name: 'desktop_template', status: 'in_progress' }, ...lanes('unrelated / ').slice(1)]
      ]).result
    ).rejects.toThrow('Timed out')
  })
})
