// Where a launch prompt sent the instant `attach` resolves reaches the adapter.
//
// Both shipped adapters look the session up in a live map and throw when it is absent
// (`claude-structured-session-adapter.ts:331-337`, `codex-structured-session-state.ts`'s
// `requireLiveCodexSession`), and both populate that map as the last step of `acquire`
// (`claude-structured-session-acquisition.ts:278`, `codex-structured-session-acquire.ts:275`).
// So the question is purely one of ordering, and that is what these model.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import { commitStructuredAgentSessionLaunchPrompt } from '../../runtime/rpc/methods/agent-launch-structured-prompt'
import {
  accepted,
  attachParams,
  CALLER,
  hostTestState
} from './structured-agent-session-host-test-harness'
import { HOST_TEST_NOW as NOW } from './structured-agent-session-host-test-data'

let host: StructuredAgentSessionHost

/** Mirrors both adapters: `acquire` publishes into the live map, `dispatch` throws without it. */
function modelAdapterLiveness(registerOnAcquire: boolean): void {
  const { acquire, dispatch } = hostTestState()
  const live = new Set<string>()
  const spawn = acquire.getMockImplementation()!
  acquire.mockImplementation(async (input) => {
    const acquisition = await spawn(input)
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

/** Exactly what `agentLaunchSurfaceFactory` does: create, then send on the create's own fence. */
async function launchAndDeliver(): Promise<{
  messageId: string | null
  dispatchState: string
}> {
  const send = vi.spyOn(host, 'send')
  const created = await host.attach(CALLER, attachParams())
  if (!created.ok) {
    throw new Error(`expected a create, got ${created.refusal.code}`)
  }
  const messageId = await commitStructuredAgentSessionLaunchPrompt({
    host,
    caller: CALLER,
    sessionId: created.value.sessionId,
    fence: created.value.fence,
    text: 'fix the failing test'
  })
  const sent = await send.mock.results[0]!.value
  if (!sent.ok) {
    return { messageId, dispatchState: `refused:${sent.refusal.code}:${sent.refusal.message}` }
  }
  // Accepted first; the delivery loop hands it over, and that outcome is what reached the agent.
  let dispatchState = sent.value.submission.dispatchState
  await vi.waitFor(() => {
    dispatchState =
      host
        .journalSnapshot(created.value.sessionId)
        .submissions.find((entry) => entry.clientMessageId === sent.value.clientMessageId)
        ?.dispatchState ?? 'missing'
    expect(dispatchState).not.toBe('pending')
  })
  return { messageId, dispatchState }
}

beforeEach(() => {
  ;({ host } = hostTestState())
  // The harness pins the host clock; operation ids are minted from `Date.now()` and carry a
  // timestamp the host expires against, so the two must agree or every send reads as stale.
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

  // Positive control: the assertion above is only evidence if this arm can fail, and it names
  // the user-visible symptom precisely — a committed row that no agent will ever answer.
  it('would commit a row and strand it if acquire ever resolved before publication', async () => {
    modelAdapterLiveness(false)

    await expect(launchAndDeliver()).resolves.toEqual({
      messageId: expect.any(String),
      dispatchState: 'unknown'
    })
  })
})
