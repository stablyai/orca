import { expect, it } from 'vitest'
import { TraexChildWork } from './traex-child-work'

it('keeps a backgrounded command labelled and stoppable after its turn finishes', () => {
  const work = new TraexChildWork('thread-label')
  work.observe('item/started', {
    threadId: 'thread-label',
    turnId: 'turn-label',
    item: {
      type: 'commandExecution',
      id: 'call-label',
      command: 'sleep 40',
      description: 'Sleep for 40 seconds in background',
      processId: '40674',
      source: 'unifiedExecStartup',
      status: 'inProgress'
    }
  })
  work.drain()
  work.observe('item/completed', {
    threadId: 'thread-label',
    turnId: 'turn-label',
    item: {
      type: 'commandExecution',
      id: 'call-label',
      command: 'sleep 40',
      description: 'Sleep for 40 seconds in background',
      processId: '40674',
      source: 'unifiedExecStartup',
      status: 'backgrounded',
      exitCode: 0
    }
  })
  expect(work.drain().some((event) => event.type === 'removed')).toBe(false)
  work.observe('turn/completed', {
    threadId: 'thread-label',
    turn: { id: 'turn-label', status: 'completed' }
  })
  work.terminals('thread-label', ['40674'])
  const labelled = work.drain().find((event) => event.type === 'live' && event.child.stoppable)
  expect(labelled).toMatchObject({
    type: 'live',
    child: { kind: 'command', description: 'sleep 40', residency: 'background', stoppable: true }
  })
  work.terminals('thread-label', [])
  expect(work.drain()).toMatchObject([{ type: 'removed' }])
})
