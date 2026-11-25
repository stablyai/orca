import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalTask } from '../../shared/local-tasks/local-task-types'
import type { HandlerContext } from '../dispatch/dispatch'
import { LOCAL_TASKS_HANDLERS } from './local-tasks'

const task = (id: string, extra: Partial<LocalTask> = {}): LocalTask => ({
  id,
  title: id,
  status: 'queued',
  statusCategory: 'todo',
  labels: [],
  url: null,
  dependsOn: [],
  priority: 3,
  claimedBy: null,
  claimedAt: null,
  blockedReason: null,
  updatedAt: '2026-01-01',
  filePath: `/t/${id}.md`,
  fields: {},
  ...extra
})

async function run(
  key: string,
  flags: Record<string, string>,
  result: unknown
): Promise<{
  call: ReturnType<typeof vi.fn>
  out: { tasks: { id: string; readiness?: unknown }[] }
}> {
  const call = vi.fn().mockResolvedValue({ id: '1', ok: true, result, _meta: {} })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handlers under test only call client.call.
  const context = {
    flags: new Map(Object.entries(flags)),
    client: { call },
    cwd: '/',
    json: true
  } as unknown as HandlerContext
  await LOCAL_TASKS_HANDLERS[key](context)
  return { call, out: JSON.parse(String(log.mock.calls[0][0])).result }
}

afterEach(() => vi.restoreAllMocks())

describe('orca local-tasks handlers', () => {
  it('list adds readiness to every task', async () => {
    const tasks = [task('a'), task('b', { dependsOn: ['a'] }), task('c', { dependsOn: ['gone'] })]
    const { out } = await run('local-tasks list', {}, { folder: '/t', tasks })
    expect(out.tasks.map((t) => t.readiness)).toEqual([
      { id: 'a', state: 'ready' },
      { id: 'b', state: 'waiting', on: ['a'] },
      { id: 'c', state: 'flagged', reason: 'missing dependency gone' }
    ])
  })

  it('next returns the best ready tasks within --slots', async () => {
    const tasks = [task('low', { priority: 4 }), task('high', { priority: 1 }), task('mid')]
    const { out } = await run('local-tasks next', { slots: '2' }, { folder: '/t', tasks })
    expect(out.tasks.map((t) => t.id)).toEqual(['high', 'mid'])
  })

  it('renew calls localTasks.renew with the holder name', async () => {
    const { call } = await run('local-tasks renew', { id: 'x', as: 'agent-1' }, task('x'))
    expect(call).toHaveBeenCalledWith('localTasks.renew', { id: 'x', claimer: 'agent-1' })
  })

  it('update sends only the given patch fields', async () => {
    const { call } = await run('local-tasks update', { id: 'x', status: 'done' }, task('x'))
    expect(call.mock.calls[0]).toEqual([
      'localTasks.update',
      {
        id: 'x',
        patch: {
          title: undefined,
          status: 'done',
          priority: undefined,
          labels: undefined,
          dependsOn: undefined,
          blockedReason: undefined,
          url: undefined
        }
      }
    ])
  })
})
