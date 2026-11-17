import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createZotzAgentQueue,
  enqueueZotzAgentTask
} from '../../shared/zotz/agent-queue/zotz-agent-queue'
import { ZotzAgentQueueStore } from './zotz-agent-queue-store'

const directories: string[] = []

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

describe('ZotzAgentQueueStore', () => {
  it('brings back the queued tasks after a restart', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'zotz-queue-'))
    directories.push(userData)
    const queue = enqueueZotzAgentTask(
      createZotzAgentQueue(),
      {
        id: 'task-1',
        agent: 'claude',
        priority: 'automation',
        estimatedBytes: 1024,
        label: 'nightly',
        launch: { prompt: 'run the tests' }
      },
      1_000
    )
    await new ZotzAgentQueueStore(userData).saveQueue(queue)

    const restored = await new ZotzAgentQueueStore(userData).loadQueue()
    expect(restored).toEqual(queue)
  })

  it('starts empty when the file is corrupt', async () => {
    const userData = await mkdtemp(join(tmpdir(), 'zotz-queue-'))
    directories.push(userData)
    await writeFile(join(userData, 'zotz-agent-queue.json'), '{ not json')
    expect((await new ZotzAgentQueueStore(userData).loadQueue()).tasks).toEqual([])
  })
})
