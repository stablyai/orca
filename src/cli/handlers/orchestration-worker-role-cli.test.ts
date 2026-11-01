import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime-client'
import { ORCHESTRATION_WORKER_LAUNCH_HANDLER } from './orchestration/worker-launch-handler'
import { ORCHESTRATION_WORKER_ROLE_ROUTING_RUNTIME_CAPABILITY } from '../../shared/orchestration-runtime-capabilities'

vi.mock('../format', () => ({ printResult: vi.fn() }))

afterEach(() => vi.restoreAllMocks())

async function invoke(capabilities: string[], options: [string, string][] = []) {
  const client = new RuntimeClient('/tmp/orca-role-cli', 60_000, null, null)
  const call = vi.spyOn(client, 'call').mockImplementation(async (method: string) => ({
    id: 'request_1',
    ok: true,
    _meta: { runtimeId: 'runtime_1' },
    result: method === 'status.get' ? { capabilities } : { state: 'ready' }
  }))
  const promise = ORCHESTRATION_WORKER_LAUNCH_HANDLER['orchestration worker-start']({
    flags: new Map([
      ['spec', 'Review changes'],
      ['role', 'review'],
      ['from', 'term_coord'],
      ...options
    ]),
    client,
    cwd: '/tmp',
    json: true
  })
  return { call, promise }
}

describe('worker-start role CLI negotiation', () => {
  it('forwards the role and explicit Fast off only after capability negotiation', async () => {
    const { call, promise } = await invoke(
      [ORCHESTRATION_WORKER_ROLE_ROUTING_RUNTIME_CAPABILITY],
      [['fast', 'off']]
    )
    await promise
    expect(call).toHaveBeenNthCalledWith(1, 'status.get')
    expect(call).toHaveBeenNthCalledWith(
      2,
      'orchestration.workerStart',
      expect.objectContaining({
        role: 'review',
        fastMode: false
      })
    )
  })

  it('refuses an old runtime without creating a task', async () => {
    const { call, promise } = await invoke([])
    await expect(promise).rejects.toMatchObject({ code: 'incompatible_runtime' })
    expect(call.mock.calls.map(([method]) => method)).toEqual(['status.get'])
  })

  it('rejects malformed Fast values before any RPC', async () => {
    const { call, promise } = await invoke(
      [ORCHESTRATION_WORKER_ROLE_ROUTING_RUNTIME_CAPABILITY],
      [['fast', 'maybe']]
    )
    await expect(promise).rejects.toThrow('--fast')
    expect(call).not.toHaveBeenCalled()
  })

  it.each(['role', 'agent', 'model', 'effort', 'fast'])(
    'refuses an empty explicit --%s instead of inheriting a different choice',
    async (flag) => {
      const { call, promise } = await invoke(
        [ORCHESTRATION_WORKER_ROLE_ROUTING_RUNTIME_CAPABILITY],
        [[flag, '']]
      )
      await expect(promise).rejects.toMatchObject({ code: 'invalid_argument' })
      expect(call).not.toHaveBeenCalled()
    }
  )
})
