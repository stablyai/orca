import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient, SendRequestOptions } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import {
  loadRemotePushAgentStates,
  loadRemotePushEnabled,
  loadRemotePushFilter,
  loadRemotePushHostRegistrations,
  saveRemotePushAgentStates,
  saveRemotePushEnabled,
  saveRemotePushHostRegistrations,
  type RemotePushAgentState,
  type RemotePushHostRegistrations
} from '../storage/preferences'
import { addPushTokenListener, getDevicePushToken, type MobilePushToken } from './push-token'
import {
  NOTIFICATIONS_REMOTE_PUSH_CAPABILITY,
  attachPushRegistration,
  resetPushRegistrationForTests,
  setRemotePushAgentStates,
  setRemotePushEnabled,
  startPushTokenSync,
  unregisterPushForRemovedHost
} from './push-registration'

vi.mock('../storage/preferences', () => ({
  loadRemotePushEnabled: vi.fn(),
  saveRemotePushEnabled: vi.fn(),
  loadRemotePushAgentStates: vi.fn(),
  saveRemotePushAgentStates: vi.fn(),
  loadRemotePushFilter: vi.fn(),
  loadRemotePushHostRegistrations: vi.fn(),
  saveRemotePushHostRegistrations: vi.fn()
}))

vi.mock('./push-token', () => ({
  getDevicePushToken: vi.fn(),
  addPushTokenListener: vi.fn()
}))

const IOS_TOKEN: MobilePushToken = {
  platform: 'ios',
  token: 'a'.repeat(64),
  apnsEnvironment: 'production'
}

// Every await in the module resolves immediately, so one macrotask drains the whole
// per-host reconcile chain no matter how many hops deep it happens to be.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function ok(result: unknown): RpcResponse {
  return { id: 'req', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

type SentRequest = { method: string; params?: unknown; options?: SendRequestOptions }

function makeClient(capabilities: readonly string[]): {
  client: Pick<RpcClient, 'sendRequest'>
  sent: SentRequest[]
} {
  const sent: SentRequest[] = []
  const client = {
    sendRequest: vi.fn(async (method: string, params?: unknown, options?: SendRequestOptions) => {
      sent.push({ method, params, options })
      if (method === 'status.get') {
        return ok({ capabilities: [...capabilities] })
      }
      if (method === 'notifications.registerPush') {
        return ok({ registered: true, registrationId: 'registration-1' })
      }
      if (method === 'notifications.unregisterPush') {
        return ok({ unregistered: true })
      }
      return ok(null)
    })
  }
  return { client, sent }
}

function methodsIn(sent: SentRequest[]): string[] {
  return sent.map((request) => request.method)
}

let enabled = false
let agentStates: readonly RemotePushAgentState[] = ['needs-input', 'finished']
let stored: RemotePushHostRegistrations

beforeEach(() => {
  vi.clearAllMocks()
  resetPushRegistrationForTests()
  enabled = false
  agentStates = ['needs-input', 'finished']
  stored = { registeredHostIds: [], pendingUnregisterHostIds: [] }

  vi.mocked(loadRemotePushEnabled).mockImplementation(async () => enabled)
  vi.mocked(saveRemotePushEnabled).mockImplementation(async (value) => {
    enabled = value
  })
  vi.mocked(loadRemotePushAgentStates).mockImplementation(async () => agentStates)
  vi.mocked(saveRemotePushAgentStates).mockImplementation(async (value) => {
    agentStates = value
  })
  vi.mocked(loadRemotePushFilter).mockImplementation(async () => ({
    sources: ['agent-task-complete', 'terminal-bell', 'plugin'],
    agentStates
  }))
  vi.mocked(loadRemotePushHostRegistrations).mockImplementation(async () => stored)
  vi.mocked(saveRemotePushHostRegistrations).mockImplementation(async (value) => {
    stored = value
  })
  vi.mocked(getDevicePushToken).mockResolvedValue(IOS_TOKEN)
})

describe('push registration capability gating', () => {
  it('registers a connected host that advertises remote push', async () => {
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)

    attachPushRegistration('host-1', client)
    await flush()

    const register = sent.find((request) => request.method === 'notifications.registerPush')
    expect(register?.params).toEqual({
      platform: 'ios',
      token: IOS_TOKEN.token,
      apnsEnvironment: 'production',
      filter: {
        sources: ['agent-task-complete', 'terminal-bell', 'plugin'],
        agentStates: ['needs-input', 'finished']
      }
    })
    expect(stored.registeredHostIds).toEqual(['host-1'])
  })

  it('never calls registerPush on a host without the capability', async () => {
    const { client, sent } = makeClient(['some-other.v1'])
    await setRemotePushEnabled(true)

    attachPushRegistration('host-legacy', client)
    await flush()

    expect(methodsIn(sent)).toEqual(['status.get'])
    expect(stored.registeredHostIds).toEqual([])
  })

  it('leaves a capable host alone while the switch is off', async () => {
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])

    attachPushRegistration('host-1', client)
    await flush()

    expect(methodsIn(sent)).toEqual(['status.get'])
  })

  it('omits apnsEnvironment for an Android token', async () => {
    vi.mocked(getDevicePushToken).mockResolvedValue({ platform: 'android', token: 'fcm-token' })
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)

    attachPushRegistration('host-1', client)
    await flush()

    const register = sent.find((request) => request.method === 'notifications.registerPush')
    expect(register?.params).toMatchObject({ platform: 'android', token: 'fcm-token' })
    expect(register?.params).not.toHaveProperty('apnsEnvironment')
  })

  it('registers nothing when the device has no push token at all', async () => {
    vi.mocked(getDevicePushToken).mockResolvedValue(null)
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)

    attachPushRegistration('host-simulator', client)
    await flush()

    expect(methodsIn(sent)).toEqual(['status.get'])
  })

  it('asks only once when the host answers that it has no push capability', async () => {
    const { client, sent } = makeClient(['some-other.v1'])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-legacy', client)
    await flush()

    await setRemotePushAgentStates(['needs-input'])
    await flush()

    expect(methodsIn(sent)).toEqual(['status.get'])
  })

  it('re-probes a host whose first status.get never answered', async () => {
    const sent: string[] = []
    let probeFails = true
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        sent.push(method)
        if (method === 'status.get') {
          if (probeFails) {
            throw new Error('request timed out')
          }
          return ok({ capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] })
        }
        return ok({ registered: true, registrationId: 'registration-1' })
      })
    }
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()
    expect(sent).toEqual(['status.get'])

    // A latched `false` would keep this host unregistered for the connection's life.
    probeFails = false
    await setRemotePushAgentStates(['needs-input'])
    await flush()

    expect(sent).toEqual(['status.get', 'status.get', 'notifications.registerPush'])
  })

  it('retries the device token on the next reconcile after the device had none', async () => {
    vi.mocked(getDevicePushToken).mockResolvedValueOnce(null).mockResolvedValue(IOS_TOKEN)
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()
    expect(methodsIn(sent)).toEqual(['status.get'])

    // A token can be missing only for now — APNs registration still in flight.
    await setRemotePushAgentStates(['needs-input'])
    await flush()

    expect(methodsIn(sent)).toContain('notifications.registerPush')
  })
})

describe('push registration token and filter changes', () => {
  it('re-registers every connected host when the provider rolls the token', async () => {
    let onTokenChange: ((token: MobilePushToken) => void) | null = null
    vi.mocked(addPushTokenListener).mockImplementation((listener) => {
      onTokenChange = listener
      return () => {}
    })
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()
    startPushTokenSync()

    onTokenChange?.({ platform: 'ios', token: 'b'.repeat(64), apnsEnvironment: 'sandbox' })
    await flush()

    const registers = sent.filter((request) => request.method === 'notifications.registerPush')
    expect(registers).toHaveLength(2)
    expect(registers[1]?.params).toMatchObject({
      token: 'b'.repeat(64),
      apnsEnvironment: 'sandbox'
    })
  })

  it('re-registers with the narrowed filter when a sub-switch is turned off', async () => {
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()

    await setRemotePushAgentStates(['needs-input'])
    await flush()

    const registers = sent.filter((request) => request.method === 'notifications.registerPush')
    expect(registers).toHaveLength(2)
    expect(registers[1]?.params).toMatchObject({
      filter: {
        sources: ['agent-task-complete', 'terminal-bell', 'plugin'],
        agentStates: ['needs-input']
      }
    })
  })
})

describe('push unregistration', () => {
  it('unregisters a connected host as soon as the switch goes off', async () => {
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()

    await setRemotePushEnabled(false)
    await flush()

    expect(methodsIn(sent)).toContain('notifications.unregisterPush')
    expect(stored.registeredHostIds).toEqual([])
    expect(stored.pendingUnregisterHostIds).toEqual([])
  })

  it('retries the unregister on a host that was offline when the switch went off', async () => {
    const first = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    const detach = attachPushRegistration('host-1', first.client)
    await flush()
    detach()

    await setRemotePushEnabled(false)
    await flush()
    expect(methodsIn(first.sent)).not.toContain('notifications.unregisterPush')
    expect(stored.pendingUnregisterHostIds).toEqual(['host-1'])

    // A fresh process: only the persisted intent survives the restart.
    resetPushRegistrationForTests()
    const reconnected = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    attachPushRegistration('host-1', reconnected.client)
    await flush()

    // No probe first: a pending entry is a switch-off the user already performed, so
    // it must not wait on a status.get that may never answer.
    expect(methodsIn(reconnected.sent)).toEqual(['notifications.unregisterPush'])
    expect(stored.pendingUnregisterHostIds).toEqual([])
  })

  it('keeps the pending intent when the retry itself fails', async () => {
    stored = { registeredHostIds: ['host-1'], pendingUnregisterHostIds: ['host-1'] }
    const client = {
      sendRequest: vi.fn(async (method: string) =>
        method === 'status.get'
          ? ok({ capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] })
          : Promise.reject(new Error('socket closed'))
      )
    }

    attachPushRegistration('host-1', client)
    await flush()

    expect(stored.pendingUnregisterHostIds).toEqual(['host-1'])
  })

  it('unregisters best-effort before a removed host loses its credentials', async () => {
    const { client, sent } = makeClient([NOTIFICATIONS_REMOTE_PUSH_CAPABILITY])
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()

    await unregisterPushForRemovedHost('host-1')

    expect(methodsIn(sent)).toContain('notifications.unregisterPush')
    expect(stored.registeredHostIds).toEqual([])
    expect(stored.pendingUnregisterHostIds).toEqual([])
  })

  it('drops a removed host that was never connected without any request', async () => {
    stored = { registeredHostIds: ['host-gone'], pendingUnregisterHostIds: ['host-gone'] }

    await unregisterPushForRemovedHost('host-gone')

    expect(stored).toEqual({ registeredHostIds: [], pendingUnregisterHostIds: [] })
  })

  it('unregisters a pending host even when its capability probe never answers', async () => {
    stored = { registeredHostIds: ['host-1'], pendingUnregisterHostIds: ['host-1'] }
    const sent: string[] = []
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        sent.push(method)
        if (method === 'status.get') {
          throw new Error('request timed out')
        }
        return ok({ unregistered: true })
      })
    }

    attachPushRegistration('host-1', client)
    await flush()

    // Gating this on the probe leaves the gateway pushing while the switch reads off.
    expect(sent).toEqual(['notifications.unregisterPush'])
    expect(stored.pendingUnregisterHostIds).toEqual([])
  })

  it('re-arms the unregister when the switch goes off while a register is in flight', async () => {
    const sent: string[] = []
    let releaseRegister: (() => void) | null = null
    const client = {
      sendRequest: vi.fn(async (method: string) => {
        sent.push(method)
        if (method === 'status.get') {
          return ok({ capabilities: [NOTIFICATIONS_REMOTE_PUSH_CAPABILITY] })
        }
        if (method === 'notifications.registerPush') {
          await new Promise<void>((resolve) => {
            releaseRegister = resolve
          })
          return ok({ registered: true, registrationId: 'registration-1' })
        }
        return ok({ unregistered: true })
      })
    }
    await setRemotePushEnabled(true)
    attachPushRegistration('host-1', client)
    await flush()

    // The sweep snapshots `registered` while this host is still only in flight.
    const switchedOff = setRemotePushEnabled(false)
    await flush()
    releaseRegister?.()
    await switchedOff
    await flush()

    // Recording the late success would leave a live gateway registration behind a
    // switch that reads off, with nothing pending to ever retract it.
    expect(sent).toContain('notifications.unregisterPush')
    expect(stored).toEqual({ registeredHostIds: [], pendingUnregisterHostIds: [] })
  })
})
