import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import {
  createRestTestRig,
  foundRestTestChat,
  REST_TEST_CALLER as CALLER,
  REST_TEST_SESSION as SESSION,
  restTestSend,
  type RestTestRig
} from './structured-agent-session-rest-test-rig'
import { hostTestOperationId } from './structured-agent-session-host-test-data'

describe('a permission pick while the agent from the last turn is still running', () => {
  let rig: RestTestRig

  beforeEach(async () => {
    rig = await createRestTestRig()
  })

  afterEach(async () => {
    await rig.dispose()
  })

  const fence = () => rig.store.getRecord(SESSION)?.lease.runtimeFence ?? 1
  const pick = (value: string) => {
    const fields = { key: 'permissionMode', value }
    return rig.host.setOption(CALLER, {
      envelope: {
        sessionId: SESSION,
        clientOperationId: hostTestOperationId(),
        expectedRuntimeFence: fence(),
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.setOption',
          sessionId: SESSION,
          fields
        })
      },
      ...fields
    })
  }
  const sendAndSettle = async (text: string, dispatches: number) => {
    expect((await rig.host.send(CALLER, restTestSend(text, fence()))).ok).toBe(true)
    await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledTimes(dispatches))
  }

  it('switches the idle agent at once, and the next send keeps that agent', async () => {
    await foundRestTestChat(rig)
    rig.adapter.closeSession.mockClear()
    rig.adapter.applyPermissionMode.mockResolvedValue(true)

    expect((await pick('full-access')).ok).toBe(true)
    await vi.waitFor(() =>
      expect(rig.adapter.applyPermissionMode).toHaveBeenCalledExactlyOnceWith(
        SESSION,
        'full-access'
      )
    )
    await sendAndSettle('after the switch', 2)
    expect(rig.adapter.closeSession).not.toHaveBeenCalled()
    expect(rig.adapter.acquire).toHaveBeenCalledTimes(1)
  })

  it('starts a new agent in the mode at the next send when the agent cannot switch', async () => {
    await foundRestTestChat(rig)
    rig.adapter.closeSession.mockClear()

    await pick('full-access')
    await vi.waitFor(() => expect(rig.adapter.applyPermissionMode).toHaveBeenCalled())
    await sendAndSettle('after the refusal', 2)
    expect(rig.adapter.closeSession).toHaveBeenCalledWith(SESSION, undefined)
    expect(rig.adapter.acquire).toHaveBeenLastCalledWith(
      expect.objectContaining({ permissionMode: 'full-access' })
    )
  })

  it('leaves an agent with a reply running alone', async () => {
    await foundRestTestChat(rig)
    const holds = rig.adapter.holdsDispatch.mockReturnValue(true)

    await pick('full-access')
    await rig.host.flushAllStreamedEvents()
    expect(rig.adapter.applyPermissionMode).not.toHaveBeenCalled()
    holds.mockReturnValue(false)
  })

  it('never switches a running agent to its own settings', async () => {
    await foundRestTestChat(rig)

    await pick('own')
    await rig.host.flushAllStreamedEvents()
    expect(rig.adapter.applyPermissionMode).not.toHaveBeenCalled()
  })
})
