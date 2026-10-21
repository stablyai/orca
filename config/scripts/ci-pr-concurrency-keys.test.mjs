import { readFileSync, readdirSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'
import { parse } from 'yaml'

const directory = '.github/workflows'
const number = 123
const sha = 'a'.repeat(40)
const githubContext = {
  event_name: 'pull_request',
  event: { pull_request: { number, head: { sha } } },
  ref: `refs/pull/${number}/merge`,
  sha: 'b'.repeat(40),
  run_id: 456
}

function evaluate(expression) {
  return expression.replace(/\$\{\{(.*?)\}\}/g, (_, source) =>
    runInNewContext(source, {
      github: githubContext,
      inputs: {},
      format: (template, value) => template.replace('{0}', value)
    })
  )
}

it('cleanup looks up the actual unique concurrency key of every automatic PR workflow', async () => {
  const expected = new Map()
  for (const file of readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))) {
    const workflow = parse(readFileSync(`${directory}/${file}`, 'utf8'))
    if (!Object.hasOwn(workflow.on ?? {}, 'pull_request')) {
      continue
    }
    expect(workflow.concurrency, file).toBeDefined()
    const key = evaluate(workflow.concurrency.group)
    expect(expected.has(key), `${file}: duplicate PR concurrency key ${key}`).toBe(false)
    expect(String(evaluate(String(workflow.concurrency['cancel-in-progress']))), file).toBe('true')
    expected.set(key, `.github/workflows/${file}`)
  }
  const cleanup = parse(readFileSync(`${directory}/ci-closed-pr-caches.yml`, 'utf8'))
  const request = vi.fn()
  let path
  const getRun = vi.fn(async () => ({
    data: { event: 'pull_request', status: 'queued', head_sha: 'c'.repeat(40), path }
  }))
  request.mockImplementation(async (_route, args) => {
    path = expected.get(args.concurrency_group_name)
    expect(path).toBeDefined()
    return { data: { group_name: args.concurrency_group_name, group_members: [{ run_id: 42 }] } }
  })
  const cancel = vi.fn()
  await runInNewContext(`(async () => { ${cleanup.jobs.clean.steps[0].with.script} })()`, {
    context: {
      repo: { owner: 'owner', repo: 'repo' },
      payload: { action: 'synchronize', pull_request: githubContext.event.pull_request }
    },
    github: {
      request,
      rest: {
        pulls: { get: async () => ({ data: { state: 'open', head: { sha } } }) },
        actions: { getWorkflowRun: getRun, cancelWorkflowRun: cancel }
      }
    },
    core: { info: vi.fn() }
  })
  expect(new Set(request.mock.calls.map(([, args]) => args.concurrency_group_name))).toEqual(
    new Set(expected.keys())
  )
  expect(cancel).toHaveBeenCalledTimes(expected.size)
})
