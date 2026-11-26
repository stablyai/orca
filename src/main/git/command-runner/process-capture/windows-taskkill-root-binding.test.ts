import { EventEmitter } from 'node:events'
import type * as ChildProcessModule from 'node:child_process'
import type * as WorkerThreadChildProcessModule from '../../../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildRequest } from '../../../worker-thread-child-process/worker-thread-child-process-protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { workerSpawn, nativeSpawn } = vi.hoisted(() => ({
  workerSpawn: vi.fn(),
  nativeSpawn: vi.fn()
}))

// Every way a taskkill could start is faked, so no test can end a real process tree.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: nativeSpawn
}))
vi.mock(
  '../../../worker-thread-child-process/worker-thread-child-process',
  async (importOriginal) => ({
    ...(await importOriginal<typeof WorkerThreadChildProcessModule>()),
    spawnProcessOnWorkerThread: workerSpawn,
    canSpawnOnWorkerThread: () => true
  })
)
vi.mock('@orca/process-host/windows-system-binary', () => ({
  windowsSystem32Binary: () => 'C:\\Windows\\System32\\taskkill.exe'
}))

import {
  WORKER_CHILD_ABANDONED_CODE,
  WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'
import { runWindowsTaskkillOffMain } from './spawned-command-tree-kill'

let requests: WorkerThreadChildRequest['type'][]
let killers: WorkerThreadChildProcess[]

beforeEach(() => {
  requests = []
  killers = []
  nativeSpawn
    .mockReset()
    .mockImplementation(() =>
      Object.assign(new EventEmitter(), { unref: () => {}, kill: () => true, pid: 9 })
    )
  workerSpawn.mockReset().mockImplementation(() => {
    const killer = new WorkerThreadChildProcess(killers.length + 1, (request) => {
      requests.push(request.type)
      return true
    })
    killers.push(killer)
    return killer
  })
})

const liveRoot = (): EventEmitter & { exitCode: number | null; signalCode: null } =>
  Object.assign(new EventEmitter(), { exitCode: null, signalCode: null })

const loseWorker = (killer: WorkerThreadChildProcess): void => {
  killer.emit(
    'error',
    Object.assign(new Error('worker lost'), { code: WORKER_CHILD_ABANDONED_CODE })
  )
}

describe('Windows taskkill on the process worker', () => {
  it('withdraws a queued taskkill once its root exits', async () => {
    const root = liveRoot()
    const verdict = runWindowsTaskkillOffMain([4242], 5_000, root)

    root.exitCode = 0
    root.emit('exit')
    expect(requests).toContain('cancel-spawn')
    killers[0].receive({ type: 'exit', id: 1, code: null, signal: 'SIGTERM' })
    killers[0].receive({ type: 'close', id: 1, code: null, signal: 'SIGTERM' })

    await expect(verdict).resolves.toBe(false)
  })

  it('never reruns from main a lost taskkill whose root has exited', async () => {
    const root = liveRoot()
    const verdict = runWindowsTaskkillOffMain([4242], 5_000, root)

    root.exitCode = 0
    loseWorker(killers[0])

    await expect(verdict).resolves.toBe(false)
    expect(nativeSpawn).not.toHaveBeenCalled()
  })

  it('reruns lost taskkills from main without merging different waits', async () => {
    void runWindowsTaskkillOffMain([1111], 5_000, liveRoot())
    void runWindowsTaskkillOffMain([2222], 2_000, liveRoot())

    loseWorker(killers[0])
    loseWorker(killers[1])
    await Promise.resolve()

    expect(nativeSpawn.mock.calls.map(([, args]) => args)).toEqual([
      ['/pid', '1111', '/t', '/f'],
      ['/pid', '2222', '/t', '/f']
    ])
  })
})
