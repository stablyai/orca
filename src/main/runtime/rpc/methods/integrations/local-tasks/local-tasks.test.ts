import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RpcDispatcher } from '../../../dispatcher'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { LOCAL_TASK_METHODS } from './local-tasks'

describe('localTasks RPC methods', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orca-local-tasks-'))
  afterEach(() => {
    delete process.env.ORCA_LOCAL_TASKS_DIR
  })

  it('lists task files from the configured folder', async () => {
    writeFileSync(join(dir, 'zz-a.md'), '---\ntitle: Task A\nstatus: working\n---\nbody\n')
    process.env.ORCA_LOCAL_TASKS_DIR = dir
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the method under test never touches the runtime.
    const runtime = { getRuntimeId: () => 'test-runtime' } as unknown as OrcaRuntimeService
    const dispatcher = new RpcDispatcher({ runtime, methods: LOCAL_TASK_METHODS })

    const reply = await dispatcher.dispatch({
      id: 'req-1',
      authToken: 'tok',
      method: 'localTasks.list'
    })

    expect(reply).toMatchObject({ result: { tasks: [{ id: 'zz-a', title: 'Task A' }] } })
    rmSync(dir, { recursive: true, force: true })
  })
})
