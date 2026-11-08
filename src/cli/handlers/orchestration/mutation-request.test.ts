import { afterEach, describe, expect, it, vi } from 'vitest'

import type { RuntimeClient } from '../../runtime-client'
import { RuntimeClientError } from '../../runtime-client'
import { callOrchestrationMutation } from './mutation-request'

const RETRY_MS = 120_000
const WORKER_DONE = {
  from: 'term_worker',
  subject: 'done',
  type: 'worker_done',
  payload: '{"taskId":"task_1","dispatchId":"ctx_1","outcome":"succeeded"}'
}

afterEach(async () => {
  vi.useRealTimers()
})

type CallOptions = { orchestrationRequestId?: string }

function fakeClient(respond: (attempt: number, options?: CallOptions) => unknown): {
  client: RuntimeClient
  requestIds: (string | undefined)[]
} {
  const requestIds: (string | undefined)[] = []
  const call = vi.fn(async (_method: string, _params: unknown, options?: CallOptions) => {
    requestIds.push(options?.orchestrationRequestId)
    return respond(requestIds.length, options)
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: callOrchestrationMutation only uses client.call.
  return { client: { call } as unknown as RuntimeClient, requestIds }
}

function unavailable(options?: CallOptions): RuntimeClientError {
  return new RuntimeClientError(
    'runtime_unavailable',
    'Could not connect to the running Orca app.',
    {
      orchestrationRequestId: options?.orchestrationRequestId,
      originalCommand: ['orca', 'orchestration', 'send', '--type', 'worker_done']
    }
  )
}

describe('callOrchestrationMutation runtime_unavailable retry', () => {
  it('keeps the recovery command when the last attempt fails before its request id is attached', async () => {
    vi.useFakeTimers()
    const { client, requestIds } = fakeClient((attempt, options) => {
      throw attempt === 1
        ? unavailable(options)
        : new RuntimeClientError('runtime_unavailable', 'No runtime metadata.')
    })
    const settled = callOrchestrationMutation(
      client,
      new Map(),
      'orchestration.send',
      WORKER_DONE,
      undefined,
      RETRY_MS
    ).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(RETRY_MS + 30_000)
    expect(await settled).toMatchObject({
      data: { recovery: { orchestrationRequestId: requestIds[0] } }
    })
  })

  // Windows cannot use this temporary Unix socket path.

  // Windows cannot use this temporary Unix socket path.
})
