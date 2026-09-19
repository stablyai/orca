import { afterEach, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './orchestration/worker-launch-handler'

vi.mock('../format', () => ({ printResult: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

it.each([undefined, 'remote-host'])('sends the canonical Antigravity agent to %s', async (on) => {
  const client = new RuntimeClient('test-profile', 60_000, null, null)
  const call = vi.spyOn(client, 'call').mockResolvedValue({
    id: 'request_1',
    ok: true,
    _meta: { runtimeId: 'runtime_1' },
    result: { state: 'ready' }
  })
  const flags = new Map<string, string | boolean>([
    ['agent', 'agy'],
    ['task', 'task_1'],
    ['worktree', 'id:folder:workspace_1'],
    ['from', 'term_coord']
  ])
  if (on) {
    flags.set('on', on)
  }

  await ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
    flags,
    client,
    cwd: '.',
    json: true
  })

  expect(call).toHaveBeenCalledWith(
    'orchestration.workerStart',
    expect.objectContaining({ agent: 'antigravity', on, worktree: 'id:folder:workspace_1' })
  )
})
