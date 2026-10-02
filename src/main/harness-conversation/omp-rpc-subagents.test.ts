import { expect, it } from 'vitest'
import { OmpRpcSubagents } from './omp-rpc-subagents'

it('retains exact lifecycle statuses and file identity without streaming child messages into the parent', () => {
  const registry = new OmpRpcSubagents()
  const started = registry.update(
    {
      id: 'Worker-2',
      agent: 'worker',
      status: 'started',
      sessionFile: '/sessions/root/Worker-2.jsonl'
    },
    100
  )
  expect(started).toEqual([
    expect.objectContaining({
      id: 'Worker-2',
      startedAt: 100,
      state: 'working',
      runStatus: 'running'
    })
  ])
  const complete = registry.update({ id: 'Worker-2', status: 'completed' }, 1_000_000)
  expect(complete[0]).toMatchObject({
    state: 'idle',
    runStatus: 'completed',
    startedAt: 100,
    transcriptPath: '/sessions/root/Worker-2.jsonl'
  })
  expect(registry.update({ progress: { id: 'Worker-2', status: 'running' } }, 1_000_001)).toEqual(
    complete
  )
  const fresh = registry.update(
    { id: 'Worker-2', status: 'started', sessionFile: '/sessions/new/Worker-2.jsonl' },
    1_000_002
  )
  expect(
    registry.update({
      id: 'Worker-2',
      status: 'failed',
      sessionFile: '/sessions/root/Worker-2.jsonl'
    })
  ).toEqual(fresh)
  const sink = {
    setSubagents: () => {
      throw new Error('must not publish child text')
    }
  }
  expect(
    registry.consume(
      {
        type: 'subagent_event',
        payload: { event: { type: 'message_update', delta: 'child answer' } }
      },
      sink
    )
  ).toBe(false)
})

it('supports nested actual ids and distinguishes aborted from failed', () => {
  const registry = new OmpRpcSubagents()
  registry.update(
    { id: 'Parent.Child', status: 'started', sessionFile: '/root/Parent.Child.jsonl' },
    100
  )
  expect(registry.update({ id: 'Parent.Child', status: 'aborted' })[0]?.runStatus).toBe('stopped')
  registry.update({ id: 'Failure', status: 'started', sessionFile: '/root/Failure.jsonl' }, 200)
  expect(
    registry.update({ id: 'Failure', status: 'failed' }).find((child) => child.id === 'Failure')
      ?.runStatus
  ).toBe('failed')
  expect(registry.update({ id: 'Unknown', status: 'not-a-status' })).toHaveLength(2)
})
