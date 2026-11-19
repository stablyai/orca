import { expect, it, vi } from 'vitest'
import {
  adapterWith,
  claudeAndCodexAgents
} from '../../providers/testing/structured-agent-session-adapter-router.test-fixture'
import { HOST_TEST_SESSION as SESSION } from './structured-agent-session-host-test-data.test-fixture'
import { eventually } from './structured-agent-session-queued-message-rig-provider.test-fixture'
import {
  createRestTestRig,
  foundRestTestChat
} from './structured-agent-session-rest-test-rig.test-fixture'

it("publishes the running child's Remote Control link and never one a replaced child reports", async () => {
  const rig = await createRestTestRig()
  try {
    await foundRestTestChat(rig)
    const acquired = await rig.adapter.acquire.mock.results[0]!.value
    const child = {
      sessionId: SESSION,
      fence: rig.store.getRecord(SESSION)!.lease.runtimeFence,
      acquisitionGeneration: acquired.acquisitionGeneration
    }
    const link = { state: 'connected' as const, sessionUrl: 'https://claude.ai/code/session_1' }

    await rig.host.handleAdapterEvent({
      type: 'provider-remote-control',
      ...child,
      acquisitionGeneration: 'generation-replaced',
      remoteControl: { state: 'failed', detail: 'from a replaced child' }
    })
    await rig.host.handleAdapterEvent({
      type: 'provider-remote-control',
      ...child,
      remoteControl: link
    })

    await vi.waitFor(() =>
      expect(rig.host.readStatusSummary(SESSION)?.providerRemoteControl).toEqual(link)
    )
    const broadcastLinks = rig.statusEvents.flatMap((event) =>
      event.type === 'status' && event.session.providerRemoteControl
        ? [event.session.providerRemoteControl]
        : []
    )
    // Any later status repeats the session's whole state, so check what was shown, not how often.
    expect(broadcastLinks).not.toContainEqual(expect.objectContaining({ state: 'failed' }))
  } finally {
    await rig.dispose()
  }
})

it('reports a chat whose agent has no Remote Control as unsupported, and saves nothing', async () => {
  const rig = await createRestTestRig()
  try {
    await foundRestTestChat(rig)

    expect(await rig.host.reads.providerRemoteControl(SESSION, 'on')).toEqual({
      status: 'unsupported'
    })
    expect(rig.store.getRecord(SESSION)?.providerRemoteControl).toBeUndefined()
  } finally {
    await rig.dispose()
  }
})

it('saves and broadcasts a choice made while no Claude process is running, with no link yet', async () => {
  const setProviderRemoteControl = vi.fn(() => false)
  const rig = await createRestTestRig({
    agents: claudeAndCodexAgents(adapterWith({ setProviderRemoteControl }))
  })
  try {
    await foundRestTestChat(rig)

    expect(await rig.host.reads.providerRemoteControl(SESSION, 'on')).toEqual({
      status: 'ok',
      choice: 'on',
      live: false
    })
    expect(setProviderRemoteControl).toHaveBeenCalledWith(SESSION, true)
    expect(rig.store.getRecord(SESSION)?.providerRemoteControl).toBe('on')
    await eventually(() => {
      const summary = rig.host.readStatusSummary(SESSION)
      expect(summary?.providerRemoteControlChoice).toBe('on')
      expect(summary?.providerRemoteControl).toBeUndefined()
    })
  } finally {
    await rig.dispose()
  }
})
