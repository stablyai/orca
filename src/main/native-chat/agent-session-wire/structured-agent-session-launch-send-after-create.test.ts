import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { restTestSend } from './structured-agent-session-rest-test-rig'
import {
  accepted,
  attachParams,
  CALLER,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_NOW as NOW } from './structured-agent-session-host-test-data'

let host: StructuredAgentSessionHost

/** Model adapter ordering: acquire publishes liveness; dispatch requires it. */
function modelAdapterLiveness(registerOnAcquire: boolean): void {
  const { acquire, dispatch } = hostTestState()
  const live = new Set<string>()
  const acquireChild = acquire.getMockImplementation()!
  acquire.mockImplementation(async (input) => {
    const acquisition = await acquireChild(input)
    if (registerOnAcquire) {
      live.add(input.identity.sessionId)
    }
    return acquisition
  })
  dispatch.mockImplementation(async ({ sessionId }) => {
    if (!live.has(sessionId)) {
      throw new Error(`no live structured session for ${sessionId}`)
    }
    return accepted()
  })
}

/** The acquired-create contract remains ordinary Send on the create's own fence. */
async function launchAndDeliver(): Promise<{
  messageId: string | null
  dispatchState: string
}> {
  const send = vi.spyOn(host, 'send')
  const created = await host.attach(CALLER, attachParams())
  if (!created.ok) {
    throw new Error(`expected a create, got ${created.refusal.code}`)
  }
  const params = restTestSend('fix the failing test', created.value.fence)
  await host.send(CALLER, params)
  const messageId = params.envelope.clientOperationId
  const sent = await send.mock.results[0]!.value
  if (!sent.ok) {
    return { messageId, dispatchState: `refused:${sent.refusal.code}:${sent.refusal.message}` }
  }
  let dispatchState = sent.value.submission.dispatchState
  await vi.waitFor(async () => {
    dispatchState =
      (await host.journalSnapshot(created.value.sessionId)).submissions.find(
        (entry) => entry.clientMessageId === sent.value.clientMessageId
      )?.dispatchState ?? 'missing'
    expect(dispatchState).not.toBe('pending')
  })
  return { messageId, dispatchState }
}

beforeEach(() => {
  ;({ host } = hostTestState())
  // Match operation-ID timestamps to the pinned host clock to avoid stale-send refusal.
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

describe('a launch prompt sent the instant the create resolves', () => {
  it('reaches a live provider, because attach returns only after acquire published it', async () => {
    modelAdapterLiveness(true)

    await expect(launchAndDeliver()).resolves.toEqual({
      messageId: expect.any(String),
      dispatchState: 'accepted'
    })
    expect(hostTestState().dispatch).toHaveBeenCalledTimes(1)
  })

  // Negative control: early acquire resolution would strand an accepted message.
  it('would commit a row and strand it if acquire ever resolved before publication', async () => {
    modelAdapterLiveness(false)

    await expect(launchAndDeliver()).resolves.toEqual({
      messageId: expect.any(String),
      dispatchState: 'unknown'
    })
  })
})
