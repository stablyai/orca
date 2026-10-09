import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { classifyPrJobs } from './pr-code-change-scope.mjs'

const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
const routes = [
  ['git_compatibility', 'src/shared/git-capability-cache.ts'],
  ['codex_index_heal_contract', 'src/main/codex/codex-session-index-heal.ts'],
  ['xterm_patch_sync', 'config/patches/xterm-upstream.json'],
  ['shell_contracts', 'src/main/pty/pty-manager.ts'],
  ['orcad_browser', 'src/main/orcad/orcad-browser-provider.ts'],
  ['cross-version-wire', 'src/shared/orchestration-rpc-contract.ts'],
  ['managed_hook_node18', 'src/shared/agent-hook-status.ts']
]

function evaluate(expression, context) {
  return runInNewContext(
    expression
      .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
      .replaceAll('.cross-version-wire', '["cross-version-wire"]'),
    context
  )
}

function routedOutputs(files, reused) {
  const scope = classifyPrJobs(files)
  const context = {
    steps: {
      readiness: { outputs: { reused } },
      filter: {
        outputs: Object.fromEntries(
          Object.entries(scope).map(([key, value]) => [key, String(value)])
        )
      }
    }
  }
  return Object.fromEntries(
    ['test', 'static_analysis', 'typecheck', ...routes.map(([job]) => job)].map((name) => [
      name,
      String(evaluate(workflow.jobs.code_paths.outputs[name], context))
    ])
  )
}

describe.each(routes)('%s preflight admission', (jobName, changedFile) => {
  const job = workflow.jobs[jobName]

  it('waits for the detector and physical preflight job', () => {
    expect(job.needs).toEqual(['code_paths', 'preflight'])
    expect(job.if).toContain('!cancelled()')
    expect(job['continue-on-error']).toBeUndefined()
  })

  it.each([
    { name: 'all prerequisites pass', admitted: true },
    { name: 'preflight fails', preflight: 'failure', admitted: false },
    { name: 'preflight is cancelled', preflight: 'cancelled', admitted: false },
    { name: 'preflight skips', preflight: 'skipped', admitted: false },
    { name: 'preflight result is missing', preflight: '', admitted: false },
    { name: 'preflight is unfinished', preflight: null, admitted: false },
    { name: 'detector fails', detector: 'failure', admitted: false },
    { name: 'detector is cancelled', detector: 'cancelled', admitted: false },
    { name: 'detector skips', detector: 'skipped', admitted: false },
    { name: 'detector result is missing', detector: '', admitted: false },
    { name: 'detector is unfinished', detector: null, admitted: false },
    { name: 'route is unselected', selected: 'false', admitted: false },
    { name: 'route is missing', selected: '', admitted: false },
    { name: 'route is absent', selected: null, admitted: false },
    { name: 'route is unknown', selected: 'unknown', admitted: false },
    { name: 'workflow is cancelled', cancelled: true, admitted: false }
  ])('evaluates the actual workflow condition: $name', (scenario) => {
    const admitted = evaluate(job.if, {
      cancelled: () => scenario.cancelled ?? false,
      needs: {
        code_paths: {
          result: scenario.detector === undefined ? 'success' : (scenario.detector ?? undefined),
          outputs: {
            [jobName]: scenario.selected === undefined ? 'true' : (scenario.selected ?? undefined)
          }
        },
        preflight: {
          result: scenario.preflight === undefined ? 'success' : (scenario.preflight ?? undefined)
        }
      }
    })
    expect(admitted).toBe(scenario.admitted)
  })

  it.each([
    { files: [] },
    { files: ['package.json'] },
    { files: ['.github/workflows/pr.yml'] },
    { files: [changedFile] }
  ])(
    'requires unit work and preflight whenever the real classifier selects $files',
    ({ files }) => {
      const selected = routedOutputs(files, 'false')
      expect(selected[jobName]).toBe('true')
      expect(selected.test).toBe('true')
      expect(selected.static_analysis).toBe('true')
      expect(selected.typecheck).toBe('true')
    }
  )

  it.each(['true', 'false', undefined])(
    'honors the actual readiness-masked output when reuse is %s',
    (reused) => {
      const outputs = routedOutputs([changedFile], reused)
      expect(outputs[jobName]).toBe(String(reused !== 'true'))
      expect(outputs.test).toBe(String(reused !== 'true'))
      const admitted = evaluate(job.if, {
        cancelled: () => false,
        needs: { code_paths: { result: 'success', outputs }, preflight: { result: 'success' } }
      })
      expect(admitted).toBe(reused !== 'true')
    }
  )
})

it.each([
  { files: ['README.md'] },
  { files: ['mobile/src/App.tsx'] },
  { files: ['mobile/package.json'] },
  { files: ['cloud/apps/relay/src/index.ts'] }
])('does not add preflight consumers to a no-unit diff: $files', ({ files }) => {
  const outputs = routedOutputs(files, 'false')
  expect(outputs.test).toBe('false')
  for (const [name] of routes) {
    expect(outputs[name], name).toBe('false')
  }
})

it('keeps the mobile-only bundle job in the first wave', () => {
  const mobile = workflow.jobs.mobile_web_app
  expect(mobile.needs).toEqual(['code_paths'])
  expect(mobile.if).toBe("needs.code_paths.outputs.mobile_web_app == 'true'")
  expect(classifyPrJobs(['mobile/src/App.tsx'])).toMatchObject({
    test: false,
    mobile_web_app: true
  })
})
