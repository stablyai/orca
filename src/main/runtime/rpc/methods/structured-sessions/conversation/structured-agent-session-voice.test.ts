import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../../../ipc/desktop-renderer-runtime-capabilities'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  HOST_TEST_SESSION as SESSION,
  HOST_TEST_THREAD as THREAD
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import {
  collectSubscriber,
  createRestTestRig,
  foundRestTestChat,
  readerSaw,
  sweepOnce,
  type RestTestRig
} from '../../../../../native-chat/agent-session-wire/host/testing/structured-agent-session-rest-test-rig'
import { claudeAndCodexDeclared } from '../../../../../native-chat/agent-session-wire/providers/testing/structured-agent-session-adapter-router-test-support'
import { STRUCTURED_AGENT_SESSION_IDLE_MS as IDLE_MS } from '../../../../../native-chat/agent-session-wire/termination/structured-agent-session-idle-sweep'
import { openStream } from '../protocol/structured-agent-session-rpc.test-fixture'

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig({
    agents: claudeAndCodexDeclared(),
    idleSweep: { intervalMs: 3_600_000 }
  })
  setStructuredAgentSessionHost(rig.host)
  await foundRestTestChat(rig)
  // Idle stop puts the chat to rest: no agent until something starts one.
  rig.clock.now += IDLE_MS + 1
  await sweepOnce(rig.host)
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
})

/** The next agent start stays unproved until the test proves it. */
function holdNextStart(): () => Promise<void> {
  const spawn = rig.adapter.acquire.getMockImplementation()!
  let spawned: Awaited<ReturnType<typeof spawn>> | undefined
  let fence = 0
  rig.adapter.acquire.mockImplementationOnce(
    rig.heldStart(async (input) => {
      fence = input.fence
      spawned = await spawn(input)
      return spawned
    })
  )
  return () =>
    rig.proveStart({
      sessionId: SESSION,
      fence,
      acquisitionGeneration: spawned!.acquisitionGeneration
    })
}

function startVoice(signal?: AbortSignal): Promise<unknown> {
  return openStream(
    'agentSession.voiceConversation',
    { sessionId: SESSION, offerSdp: 'v=0' },
    {
      clientKind: 'runtime',
      clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES,
      ...(signal ? { signal } : {})
    },
    // A transport abort closes the stream, as the real subscription registry does.
    {
      registerOwnedSubscriptionCleanup: (_id: string, cleanup: () => void) => ({
        releaseIfCurrent: cleanup
      })
    }
  )
}

/** Waits until status shows the held agent starting, so a call opened before readiness would show. */
async function startPublished(seen: number): Promise<void> {
  await vi.waitFor(() =>
    expect(
      rig.statusEvents
        .slice(seen)
        .some(
          (event) =>
            event.type === 'status' &&
            event.session.sessionId === SESSION &&
            event.session.hostExecutionPhase === 'starting'
        )
    ).toBe(true)
  )
}

describe('agentSession.voiceConversation on a Codex chat that idle stop put to rest', () => {
  it('starts the agent on its own thread and opens the call only once it is ready', async () => {
    const prove = holdNextStart()
    const seen = rig.statusEvents.length

    const first = startVoice()
    await startPublished(seen)
    // A second press finds the agent already starting but not ready.
    const second = startVoice()
    await vi.waitFor(() => expect(rig.statusEvents.length).toBeGreaterThan(seen))
    expect(rig.adapter.startVoiceConversation).not.toHaveBeenCalled()

    await prove()
    await Promise.all([first, second])

    // One provider process for both attempts, resumed on the chat's own Codex thread.
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(2)
    expect(rig.adapter.acquire.mock.calls[1]?.[0].identity.providerHandle).toMatchObject({
      agent: 'codex',
      nativeId: THREAD
    })
    expect(rig.adapter.startVoiceConversation).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION, offerSdp: 'v=0' })
    )
    const reader = collectSubscriber()
    await rig.host.subscribe({ id: 'reader', sessionId: SESSION, emit: reader.emit })
    expect(readerSaw(reader.events).texts).toContain('hello')
  })

  it('opens no call when the caller hangs up while the agent is starting', async () => {
    const prove = holdNextStart()
    const hangUp = new AbortController()
    const seen = rig.statusEvents.length

    const attempt = startVoice(hangUp.signal)
    await startPublished(seen)
    hangUp.abort()
    await prove()
    await attempt

    expect(rig.adapter.startVoiceConversation).not.toHaveBeenCalled()
  })
})
