import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import {
  CALLER,
  envelope
} from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-harness'
import { HOST_TEST_SESSION as SESSION } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-host-test-data'
import { waitFor } from './testing/acp-structured-adapter.test-support'
import {
  attachParams,
  hello,
  launch,
  openHostRig
} from './testing/acp-structured-host.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

describe('closing or stopping a Grok chat while it starts', () => {
  it('retains a published startup child whose close is unproven and retries before another spawn', async () => {
    const { rig, host } = await openHostRig({ script: (agent) => agent.on('initialize', () => {}) })
    expect(await host.attach(CALLER, attachParams())).toMatchObject({ ok: true })
    await rig.frame('initialize')
    const child = rig.child()
    child.proveClose = vi.fn(async () => false)
    try {
      await expect(host.close(SESSION, 'user-close')).rejects.toThrow('eviction failed')
      expect(child.exited).toBe(false)
      expect(rig.spawned.filter((step) => step === 'spawn')).toHaveLength(1)
    } finally {
      child.proveClose = vi.fn(async () => {
        child.exit()
        return true
      })
      await host.close(SESSION, 'user-close')
    }
    expect(child.exited).toBe(true)
    await host.send(CALLER, {
      envelope: envelope('agentSession.send', { body: hello }),
      body: hello
    })
    await waitFor(() => expect(rig.child()).not.toBe(child))
    await host.close(SESSION, 'user-close')
  })

  it('leaves a starting child alone when Stop names an earlier turn', async () => {
    const { rig, host } = await openHostRig({
      script: (agent) => agent.on('initialize', () => {})
    })
    const attaching = host.attach(CALLER, attachParams())
    await rig.frame('initialize')
    const stopping = host.cancel(CALLER, {
      envelope: envelope('agentSession.cancel', { turnId: 'turn-of-an-old-child' }),
      turnId: 'turn-of-an-old-child'
    })
    expect(await stopping).toMatchObject({ ok: true, value: { cancelled: false } })
    await rig.settle()
    expect(rig.child().closes).toBe(0)
    expect(rig.child().exited).toBe(false)
    await host.close(SESSION, 'user-close')
    await attaching
  })

  it('never spawns a child for a start closed while its launch was still resolving', async () => {
    let releaseLaunch: () => void = () => {}
    const resolving = { started: false }
    const { rig, host } = await openHostRig({
      deps: {
        resolveLaunch: async () => {
          resolving.started = true
          await new Promise<void>((resolve) => {
            releaseLaunch = resolve
          })
          return launch(() => false)()
        }
      }
    })
    const attaching = host.attach(CALLER, attachParams()).catch((error: unknown) => error)
    await waitFor(() => expect(resolving.started).toBe(true))
    const closing = host.close(SESSION, 'user-close')
    releaseLaunch()
    expect(await attaching).toMatchObject({ name: 'AgentSessionPreSpawnError' })
    await closing
    expect(rig.spawned).toEqual([])
    expect(await rig.adapter.closeSession(SESSION)).toBe(true)
  })
})
