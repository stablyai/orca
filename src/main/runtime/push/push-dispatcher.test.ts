import { describe, expect, it, vi } from 'vitest'
import type { MobilePushFilter, MobilePushRegistration } from '../../../shared/mobile-push-contract'
import type { MobileNotificationEvent } from '../runtime-mobile-notification-controller'
import type { PushGatewayClient, PushSendResult } from './push-gateway-client'
import { PushDispatcher, mapPushAgentState, type PushDispatcherRegistry } from './push-dispatcher'

const ALL_SOURCES: MobilePushFilter = {
  sources: ['agent-task-complete', 'terminal-bell', 'plugin'],
  agentStates: ['needs-input', 'finished']
}

function registration(overrides: Partial<MobilePushRegistration> = {}): MobilePushRegistration {
  return {
    registrationId: 'reg-1',
    platform: 'ios',
    filter: ALL_SOURCES,
    registeredAt: 1,
    ...overrides
  }
}

type SendCall = Parameters<PushGatewayClient['send']>[0]

function createHarness(options: {
  devices: { deviceId: string; pushRegistration?: MobilePushRegistration }[]
  results?: PushSendResult[]
  sendImpl?: () => Promise<never>
}): {
  dispatcher: PushDispatcher
  sends: SendCall[]
  cleared: (string | null)[]
  runRetry: () => void
} {
  const sends: SendCall[] = []
  const cleared: (string | null)[] = []
  let retry: (() => void) | null = null
  const client = {
    send: vi.fn(async (input: SendCall) => {
      sends.push(input)
      if (options.sendImpl) {
        return await options.sendImpl()
      }
      return {
        ok: true as const,
        results:
          options.results ??
          input.registrationIds.map((registrationId) => ({
            registrationId,
            status: 'queued' as const
          }))
      }
    })
  } as unknown as PushGatewayClient
  const registry: PushDispatcherRegistry = {
    listDevices: () => options.devices,
    setPushRegistration: (deviceId, value) => {
      cleared.push(value === null ? deviceId : null)
      return true
    }
  }
  return {
    dispatcher: new PushDispatcher({
      client,
      registry,
      scheduleRetry: (run) => {
        retry = run
      }
    }),
    sends,
    cleared,
    runRetry: () => retry?.()
  }
}

function notification(overrides: Partial<MobileNotificationEvent> = {}): MobileNotificationEvent {
  return {
    type: 'notification',
    source: 'agent-task-complete',
    title: 'feat/x - Claude finished',
    body: 'All done.',
    worktreeId: 'repo::wt1',
    notificationId: 'agent:one',
    notificationSeq: 7,
    notificationEpoch: 'epoch-1',
    agentState: 'done',
    ...overrides
  } as MobileNotificationEvent
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('mapPushAgentState', () => {
  it.each([
    ['blocked', 'needs-input'],
    ['waiting', 'needs-input'],
    ['done', 'finished'],
    [undefined, 'finished']
  ] as const)('maps agent-task-complete %s to %s', (agentState, expected) => {
    expect(mapPushAgentState('agent-task-complete', agentState)).toBe(expected)
  })

  it('suppresses a still-working agent', () => {
    expect(mapPushAgentState('agent-task-complete', 'working')).toBeUndefined()
  })

  it('leaves non-agent sources without a state', () => {
    expect(mapPushAgentState('terminal-bell', undefined)).toBeNull()
  })
})

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

  it('never pushes a dismissal', async () => {
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

    expect(harness.sends).toHaveLength(0)
  })

  it('stays silent while the agent is still working', async () => {
    const harness = createHarness({
      devices: [{ deviceId: 'a', pushRegistration: registration() }]
    })

    harness.dispatcher.enqueue(notification({ agentState: 'working' }))
    await flush()

    expect(harness.sends).toHaveLength(0)
  })

  it('applies each device filter independently', async () => {
    const harness = createHarness({
      devices: [
        {
          deviceId: 'needs-input-only',
          pushRegistration: registration({
            registrationId: 'reg-needs',
            filter: { sources: ['agent-task-complete'], agentStates: ['needs-input'] }
          })
        },
        {
          deviceId: 'bells-only',
          pushRegistration: registration({
            registrationId: 'reg-bell',
            filter: { sources: ['terminal-bell'], agentStates: ['needs-input', 'finished'] }
          })
        },
        { deviceId: 'everything', pushRegistration: registration({ registrationId: 'reg-all' }) }
      ]
    })

    harness.dispatcher.enqueue(notification({ agentState: 'blocked' }))
    await flush()

    expect(harness.sends[0]?.registrationIds).toEqual(['reg-needs', 'reg-all'])
  })

  it('pushes a bell to a device that filtered agent states out', async () => {
    const harness = createHarness({
      devices: [
        {
          deviceId: 'a',
          pushRegistration: registration({
            filter: { sources: ['terminal-bell'], agentStates: [] }
          })
        }
      ]
    })

    harness.dispatcher.enqueue(
      notification({ source: 'terminal-bell', agentState: undefined, title: 'Bell in x' })
    )
    await flush()

    expect(harness.sends[0]?.notification.agentState).toBeNull()
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

  it('retries once when the gateway is unreachable', async () => {
    const sends: SendCall[] = []
    const client = {
      send: vi.fn(async (input: SendCall) => {
        sends.push(input)
        return { ok: false as const, reason: 'unreachable' as const }
      })
    } as unknown as PushGatewayClient
    const scheduled: (() => void)[] = []
    const dispatcher = new PushDispatcher({
      client,
      registry: {
        listDevices: () => [{ deviceId: 'a', pushRegistration: registration() }],
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
