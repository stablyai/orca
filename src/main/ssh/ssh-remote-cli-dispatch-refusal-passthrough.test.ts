import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/host/app'
  }
}))
vi.mock('../persistence', () => ({
  getCanonicalUserDataPath: () => '/host/user-data'
}))

import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runRemoteOrcaCli } from './ssh-remote-orca-cli'

// Why: the SSH bridge relays the host CLI's stdout byte-for-byte; a typed dispatch refusal must
// arrive at the remote agent with the same code and data it would see locally.
it('relays typed dispatch refusal codes from the host CLI unchanged', async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn(), on: vi.fn() }
  child.kill = vi.fn()
  const spawn = vi.fn(() => child)
  const refusal = {
    id: 'rpc_1',
    ok: false,
    error: {
      code: 'task_not_ready',
      message: 'Task task_1 is pending; only ready tasks can be dispatched',
      data: { taskId: 'task_1', status: 'pending', unmetDependencies: ['task_0'] }
    },
    _meta: { runtimeId: 'runtime_1' }
  }

  const resultPromise = runRemoteOrcaCli(
    new OrcaRuntimeService(),
    {
      argv: ['orchestration', 'dispatch', '--task', 'task_1', '--to', 'term_w', '--json'],
      cwd: '/home/alice/repo',
      env: { ORCA_TERMINAL_HANDLE: 'term_ssh' }
    },
    {
      execPath: '/host/electron',
      cliEntryPath: '/host/app/out/cli/index.js',
      userDataPath: '/host/user-data',
      entryExists: () => true,
      spawn: spawn as never
    }
  )

  await Promise.resolve()
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(refusal, null, 2)}\n`))
  child.emit('close', 1)

  const result = await resultPromise
  expect(result.exitCode).toBe(1)
  expect(JSON.parse(result.stdout)).toEqual(refusal)
})
