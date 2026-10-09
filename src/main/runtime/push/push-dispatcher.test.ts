import { describe, expect, it, vi } from 'vitest'
import type { PushGatewayClient } from './push-gateway-client'
import { PushDispatcher } from './push-dispatcher'
import {
  createHarness,
  flush,
  notification,
  registration,
  type SendCall
} from './push-dispatcher.test-fixture'
import { openSealedPushNotification } from './push-e2e-seal.test-fixture'

describe('PushDispatcher', () => {
  it('batches every matching registration into one send', async () => {
    const harness = createHarness({
      devices: [
        { deviceId: 'a', pushRegistration: registration({ registrationId: 'reg-a' }) },
        { deviceId: 'b', pushRegistration: registration({ registrationId: 'reg-b' }) },
        { deviceId: 'c' }
      ]
    })

    harness.dispatcher.enqueue(notification())
    await flush()

    expect(harness.sends).toHaveLength(1)
    expect(harness.sends[0]?.registrationIds).toEqual(['reg-a', 'reg-b'])
    expect(harness.sends[0]?.notification).toMatchObject({
      source: 'agent-task-complete',
      agentState: 'finished',
      notificationSeq: 7,
      notificationEpoch: 'epoch-1',
      worktreeId: 'repo::wt1'
    })
  })

  it('fans out past the per-request cap instead of starving the extra devices', async () => {
    const devices = Array.from({ length: 25 }, (_, index) => ({
      deviceId: `device-${index}`,
      pushRegistration: registration({ registrationId: `reg-${index}` })
    }))
    const harness = createHarness({ devices })

    harness.dispatcher.enqueue(notification())
    await flush()

    expect(harness.sends).toHaveLength(2)
    expect(harness.sends[0]?.registrationIds).toHaveLength(20)
    expect(harness.sends[1]?.registrationIds).toEqual([
      'reg-20',
      'reg-21',
      'reg-22',
      'reg-23',
      'reg-24'
    ])
  })

  it('drops a dead registration reported by a later chunk', async () => {
    const devices = Array.from({ length: 25 }, (_, index) => ({
      deviceId: `device-${index}`,
      pushRegistration: registration({ registrationId: `reg-${index}` })
    }))
    const harness = createHarness({
      devices,
      results: [{ registrationId: 'reg-24', status: 'dead' }]
    })

    harness.dispatcher.enqueue(notification())
    await flush()

    expect(harness.cleared).toEqual(['device-24'])
  })

  it('pushes a silent dismissal with an absolute expiry', async () => {
    const harness = createHarness({
      devices: [{ deviceId: 'a', pushRegistration: registration() }]
    })

    harness.dispatcher.enqueue({
      type: 'dismiss',
      notificationId: 'agent:one',
      notificationSeq: 8,
      notificationEpoch: 'epoch-1'
    })
    await flush()

    expect(harness.sends).toHaveLength(1)
    expect(harness.sends[0]?.notification).toMatchObject({
      kind: 'dismiss',
      sound: false,
      notificationId: 'agent:one',
      expiresAt: expect.any(Number)
    })
  })

  it('stays silent while the agent is still working', async () => {
    const harness = createHarness({
      devices: [{ deviceId: 'a', pushRegistration: registration() }]
    })

    harness.dispatcher.enqueue(notification({ agentState: 'working' }))
    await flush()

    expect(harness.sends).toHaveLength(0)
  })

  it('drops a registration the gateway reports dead', async () => {
    const harness = createHarness({
      devices: [
        { deviceId: 'a', pushRegistration: registration({ registrationId: 'reg-a' }) },
        { deviceId: 'b', pushRegistration: registration({ registrationId: 'reg-b' }) }
      ],
      results: [
        { registrationId: 'reg-a', status: 'dead' },
        { registrationId: 'reg-b', status: 'queued' }
      ]
    })

    harness.dispatcher.enqueue(notification())
    await flush()

    expect(harness.cleared).toEqual(['a'])
  })

  it('seals pushes for phones that opted in and leaves older phones readable', async () => {
    const harness = createHarness({
      devices: [
        {
          deviceId: 'sealed-a',
          pushRegistration: registration({ registrationId: 'reg-a', sealedContent: 'e2e1' })
        },
        { deviceId: 'legacy', pushRegistration: registration({ registrationId: 'reg-legacy' }) },
        {
          deviceId: 'sealed-b',
          pushRegistration: registration({
            registrationId: 'reg-b',
            sealedContent: 'e2e1',
            filter: { sound: false }
          })
        }
      ]
    })

    harness.dispatcher.enqueue(notification())
    harness.dispatcher.enqueue({
      type: 'dismiss',
      notificationId: 'agent:one',
      notificationSeq: 8,
      notificationEpoch: 'epoch-1'
    })
    await flush()

    const byRegistration = (id: string) =>
      harness.sends.filter((send) => send.registrationIds.includes(id))
    const [legacyAlert] = byRegistration('reg-legacy')
    expect(legacyAlert).toMatchObject({
      registrationIds: ['reg-legacy'],
      notification: { title: 'feat/x - Claude finished', body: 'All done.' }
    })
    const [alertA, dismissA] = byRegistration('reg-a')
    const [alertB, dismissB] = byRegistration('reg-b')
    for (const send of [alertA, dismissA, alertB, dismissB]) {
      expect(send?.registrationIds).toHaveLength(1)
      const wire = JSON.stringify(send)
      expect(wire).not.toMatch(/feat\/x|All done\.|repo::wt1|agent:one|epoch-1/)
    }
    expect(alertB?.notification.sound).toBe(false)
    expect(openSealedPushNotification(alertA!.notification, 'token-sealed-a')).toMatchObject({
      title: 'feat/x - Claude finished',
      body: 'All done.',
      worktreeId: 'repo::wt1',
      notificationId: 'agent:one',
      notificationEpoch: 'epoch-1'
    })
    // The gateway refuses a differing copy of an event it already holds, so each phone's event differs.
    expect(alertA?.notification.notificationEpoch).not.toBe(alertB?.notification.notificationEpoch)
    // A dismissal names the alert it retracts by that phone's own opaque ids.
    expect(dismissA?.notification).toMatchObject({
      kind: 'dismiss',
      notificationId: alertA?.notification.notificationId,
      notificationEpoch: alertA?.notification.notificationEpoch
    })
    expect(dismissB?.notification.notificationId).toBe(alertB?.notification.notificationId)
  })

  it('never sends readable text to a sealed phone without a pairing token', async () => {
    const harness = createHarness({
      devices: [
        { deviceId: 'a', token: '', pushRegistration: registration({ sealedContent: 'e2e1' }) }
      ]
    })

    harness.dispatcher.enqueue(notification())
    await flush()

    expect(harness.sends).toHaveLength(0)
  })

  it('retries once when the gateway is unreachable', async () => {
    const sends: SendCall[] = []
    const client = {
      send: vi.fn(async (input: SendCall) => {
        sends.push(input)
        return { ok: false as const, reason: 'unreachable' as const }
      })
    } as unknown as PushGatewayClient
    const scheduled: (() => void)[] = []
    const devices = [{ deviceId: 'a', token: 'token-a', pushRegistration: registration() }]
    const dispatcher = new PushDispatcher({
      client,
      registry: {
        listDevices: () => devices,
        setPushRegistration: () => true
      },
      scheduleRetry: (run, delayMs) => {
        expect(delayMs).toBe(2_000)
        scheduled.push(run)
      }
    })

    dispatcher.enqueue(notification())
    await flush()
    expect(sends).toHaveLength(1)
    expect(scheduled).toHaveLength(1)

    scheduled[0]?.()
    await flush()
    expect(sends).toHaveLength(2)
    // The second attempt is the last one; a further retry is never scheduled.
    expect(scheduled).toHaveLength(1)
  })

  it('never throws into the caller when the client rejects', async () => {
    const harness = createHarness({
      devices: [{ deviceId: 'a', pushRegistration: registration() }],
      sendImpl: async () => {
        throw new Error('boom')
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => harness.dispatcher.enqueue(notification())).not.toThrow()
    await flush()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('never throws when the registry itself fails', async () => {
    const dispatcher = new PushDispatcher({
      client: { send: vi.fn() } as unknown as PushGatewayClient,
      registry: {
        listDevices: () => {
          throw new Error('registry unavailable')
        },
        setPushRegistration: () => true
      }
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() => dispatcher.enqueue(notification())).not.toThrow()
    warn.mockRestore()
  })
})
