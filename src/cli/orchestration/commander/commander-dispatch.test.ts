import { afterEach, expect, it, vi } from 'vitest'
import { WorkerStartParams } from '../../../shared/rpc-contract/orchestration/orchestration-worker-start-params'
import type { CommanderMemoryRevision } from '../../../shared/commander/memory-contract'
import { orchestrationTestContext } from '../orchestration-handler-test-context'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from '../workers/worker-launch-handler'
import { planCommanderDispatch } from './model-routing'

const project = 'github:acme/sdk'
const actor = { type: 'human' as const, id: 'owner' }
const guide: CommanderMemoryRevision = {
  pageId: 'test-first',
  title: 'Tests',
  kind: 'guideline',
  body: 'Verify the smallest relevant test.',
  projectId: project,
  actor,
  createdBy: actor,
  createdAt: '2026-11-21T00:00:00Z',
  version: 2,
  deleted: false,
  links: []
}
const entry = {
  agent: 'codex',
  taskKind: 'docs',
  containsAny: ['readme'],
  model: 'gpt-5.4-mini',
  effort: 'low',
  reason: 'Use the smaller model for routine edits.'
}
const modelGuide = {
  ...guide,
  pageId: 'routing',
  title: 'Worker model routing',
  body: JSON.stringify({ version: 1, routes: [entry] })
}
const projectPlan = {
  pages: [modelGuide, guide],
  projectId: project,
  agent: 'codex' as const,
  spec: 'Fix the README',
  createsWorktree: false
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it('dispatches a worker with scoped human instructions and the audited model choice', async () => {
  vi.stubEnv('ORCA_COMMANDER_MEMORY_TOKEN', 'orcacmd_test').stubEnv(
    'ORCA_COMMANDER_MEMORY_URL',
    'http://127.0.0.1/v1/commander/memory'
  )
  const machine = { type: 'agent' as const, id: 'other' }
  const checkpoint = {
    ...guide,
    pageId: `checkpoint-${'a'.repeat(64)}`,
    kind: 'note' as const,
    body: 'SDK tests passed.',
    actor: { type: 'commander' as const, id: 'orca-checkpoint' },
    createdAt: '2026-11-21T01:00:00Z'
  }
  const pages = [
    {
      ...checkpoint,
      createdAt: '2026-11-20T01:00:00Z',
      pageId: `checkpoint-${'b'.repeat(64)}`,
      body: 'Older progress.'
    },
    {
      ...checkpoint,
      createdAt: '2026-11-22T01:00:00Z',
      pageId: `checkpoint-${'c'.repeat(64)}`,
      deleted: true
    },
    {
      ...checkpoint,
      createdAt: '2026-11-22T01:00:00Z',
      pageId: `checkpoint-${'d'.repeat(64)}`,
      projectId: 'github:acme/other'
    },
    checkpoint,
    { ...guide, title: 'Recurring answer', body: 'Do not inject this exact choice' },
    guide,
    modelGuide,
    { ...guide, pageId: 'agent-edit', body: 'Machine advice', actor: machine },
    {
      ...guide,
      pageId: 'another-project',
      body: 'Other project text',
      projectId: 'github:acme/other'
    }
  ]
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    if (options.method === 'GET') {
      return Response.json({
        actor: { type: 'commander', id: 'leader' },
        projectId: project,
        pages
      })
    }
    const write = JSON.parse(String(options.body))
    expect(write.links).toEqual(['test-first', 'routing', checkpoint.pageId])
    expect(write.body).toContain('gpt-5.4-mini')
    expect(write.body).toContain('routing (revision 2)')
    return Response.json({
      planSaved: true,
      page: { ...guide, ...write, actor: { type: 'commander', id: 'leader' }, version: 1 }
    })
  })
  vi.stubGlobal('fetch', fetchMock)
  const rpc = vi.fn(async (method: string, _params?: unknown) => {
    if (method === 'status.get') {
      return { result: { capabilities: ['orchestration.commander-dispatch.v1'] } }
    }
    return { result: { dispatchId: 'dispatch_one', taskId: 'task_one', state: 'ready' } }
  })
  await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start'](
    orchestrationTestContext(
      rpc,
      new Map([
        ['spec', 'Update the README'],
        ['for', 'msg_review'],
        ['agent', 'codex'],
        ['from', 'term_coordinator'],
        ['commander-project', project]
      ]),
      true
    )
  )
  const worker = rpc.mock.calls.find(([method]) => method === 'orchestration.workerStart')
  const { commander } = WorkerStartParams.parse(worker?.[1])
  expect(commander?.guidelines).toContain('Verify the smallest relevant test.')
  expect(commander?.guidelines).toContain('commander_ask_preference')
  expect(commander?.guidelines).toContain('orchestration ask')
  expect(commander?.guidelines).not.toContain('Do not inject this exact choice')
  expect(rpc).toHaveBeenCalledWith(
    'orchestration.workerStart',
    expect.objectContaining({
      model: 'gpt-5.4-mini',
      effort: 'low',
      forQuestion: 'msg_review',
      commander: expect.objectContaining({
        projectId: project,
        reason: 'Use the smaller model for routine edits.',
        guidelines: expect.stringContaining('> SDK tests passed.')
      })
    }),
    expect.objectContaining({ orchestrationRequestId: expect.any(String) })
  )
})

it('preserves an explicitly selected model without inheriting effort from another model', () => {
  expect(planCommanderDispatch({ ...projectPlan, model: 'user-model' })).toMatchObject({
    model: 'user-model',
    effort: undefined,
    reason: 'Caller supplied --model.'
  })
})

it('refuses an ambiguous or unsupported route before dispatch', () => {
  const ambiguous = {
    ...modelGuide,
    body: JSON.stringify({ version: 1, routes: [entry, { ...entry, model: 'larger' }] })
  }
  expect(() => planCommanderDispatch({ ...projectPlan, pages: [ambiguous] })).toThrow(
    'Multiple Commander model rules'
  )
  expect(() => planCommanderDispatch({ ...projectPlan, effort: 'impossible' })).toThrow(
    'does not support effort'
  )
})

it('measures UTF-8 guideline bytes before sending a prompt', () => {
  expect(() =>
    planCommanderDispatch({ ...projectPlan, pages: [{ ...guide, body: '豆'.repeat(2800) }] })
  ).toThrow('8192')
})

it('prefers a matching project rule over the same account rule, preserving an explicit effort', () => {
  const accountDefault = {
    ...modelGuide,
    pageId: 'account-models',
    projectId: null,
    body: JSON.stringify({ version: 1, routes: [{ ...entry, model: 'account-model' }] })
  }
  expect(
    planCommanderDispatch({ ...projectPlan, effort: 'high', pages: [accountDefault, modelGuide] })
  ).toMatchObject({
    model: 'gpt-5.4-mini',
    effort: 'high',
    sources: [{ pageId: 'routing', version: 2 }]
  })
})

it('retries the original dispatch after its policy changes and refuses a different request for the same key', async () => {
  vi.stubEnv('ORCA_COMMANDER_MEMORY_TOKEN', 'orcacmd_test').stubEnv(
    'ORCA_COMMANDER_MEMORY_URL',
    'http://127.0.0.1/v1/commander/memory'
  )
  let pages = [guide, modelGuide]
  let frozen: { plan: unknown; pageId: string; projectId: string } | undefined
  let originalId = ''
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.includes('/dispatch-plans/')) {
        return Response.json(frozen)
      }
      if (options.method === 'GET') {
        return Response.json({
          actor: { type: 'commander', id: 'leader' },
          projectId: project,
          pages
        })
      }
      if (frozen) {
        return Response.json({}, { status: 409 })
      }
      const write = JSON.parse(String(options.body))
      originalId = write.requestId
      frozen = { projectId: project, pageId: write.pageId, plan: write.replayPlan }
      return Response.json({
        planSaved: true,
        page: { ...guide, ...write, actor: { type: 'commander', id: 'leader' }, version: 1 }
      })
    })
  )
  const inputs: unknown[] = []
  let hostId = 'install-first'
  const rpc = vi.fn(async (method: string, params: unknown, options: unknown) => {
    if (method === 'status.get') {
      return {
        result: {
          capabilities: ['orchestration.commander-dispatch.v1'],
          hostDescriptor: { installationId: hostId }
        }
      }
    }
    inputs.push({ params, options })
    return { result: { dispatchId: 'dispatch_one', taskId: 'task_one', state: 'ready' } }
  })
  const flags = new Map<string, string | boolean>([
    ['spec', 'Update the README'],
    ['agent', 'codex'],
    ['from', 'term_coord'],
    ['commander-project', project]
  ])
  const start = () =>
    ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start'](
      orchestrationTestContext(rpc, flags, true)
    )
  await start()
  flags.set('retry-request', originalId)
  pages = [
    { ...guide, body: 'Use the new guide' },
    { ...modelGuide, body: 'policy temporarily invalid' }
  ]
  await start()
  expect(inputs).toHaveLength(2)
  expect(inputs[1]).toStrictEqual(inputs[0])
  flags.set('spec', 'Release the SDK')
  await expect(start()).rejects.toThrow('does not match')
  flags.set('spec', 'Update the README')
  hostId = 'different-install'
  await expect(start()).rejects.toThrow('does not match')
  expect(inputs).toHaveLength(2)
})
