import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RpcContext, RpcMethod } from '../rpc/core'
import { NOTIFICATION_METHODS } from '../rpc/methods/notifications'
import { DeviceRegistry } from '../device-registry'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { OrcaRuntimeService } from '../orca-runtime'

function method(name: string): RpcMethod {
  const found = NOTIFICATION_METHODS.find((candidate) => candidate.name === name)
  if (!found || 'stream' in found) {
    throw new Error(`${name} is not a one-shot RPC method`)
  }
  return found
}

const REGISTER_PARAMS = {
  platform: 'ios',
  token: 'a'.repeat(64),
  apnsEnvironment: 'sandbox',
  filter: { sources: ['agent-task-complete'], agentStates: ['finished'] }
}

function contextFor(overrides: Partial<RpcContext>): RpcContext {
  return {
    runtime: {
      registerMobilePushDevice: vi.fn(async () => ({
        registered: true,
        registrationId: 'reg-1'
      })),
      unregisterMobilePushDevice: vi.fn(async () => ({ unregistered: true }))
    },
    ...overrides
  } as unknown as RpcContext
}

describe('notifications.registerPush', () => {
  it('registers under the authenticated paired device id', async () => {
    const registerPush = method('notifications.registerPush')
    const ctx = contextFor({ clientKind: 'mobile', pairedDeviceId: 'device-1' })

    const result = await registerPush.handler(registerPush.params!.parse(REGISTER_PARAMS), ctx)

    expect(result).toEqual({ registered: true, registrationId: 'reg-1' })
    expect(ctx.runtime.registerMobilePushDevice).toHaveBeenCalledWith({
      deviceId: 'device-1',
      platform: 'ios',
      token: REGISTER_PARAMS.token,
      apnsEnvironment: 'sandbox',
      filter: REGISTER_PARAMS.filter
    })
  })

  it.each([
    ['a runtime-scoped caller', { clientKind: 'runtime' as const, pairedDeviceId: 'device-1' }],
    ['an in-process caller', {}],
    ['a mobile caller with no paired device', { clientKind: 'mobile' as const }]
  ])('refuses %s', async (_name, overrides) => {
    const registerPush = method('notifications.registerPush')
    const ctx = contextFor(overrides)

    expect(await registerPush.handler(registerPush.params!.parse(REGISTER_PARAMS), ctx)).toEqual({
      registered: false,
      reason: 'not_mobile'
    })
    expect(ctx.runtime.registerMobilePushDevice).not.toHaveBeenCalled()
  })

  it('requires an APNs environment for an iOS token', () => {
    const registerPush = method('notifications.registerPush')
    expect(
      registerPush.params!.safeParse({ ...REGISTER_PARAMS, apnsEnvironment: undefined }).success
    ).toBe(false)
    expect(
      registerPush.params!.safeParse({
        ...REGISTER_PARAMS,
        platform: 'android',
        apnsEnvironment: undefined
      }).success
    ).toBe(true)
  })

  it('rejects a source the contract does not define', () => {
    const registerPush = method('notifications.registerPush')
    expect(
      registerPush.params!.safeParse({
        ...REGISTER_PARAMS,
        filter: { sources: ['smoke-signal'], agentStates: [] }
      }).success
    ).toBe(false)
  })
})

describe('notifications.unregisterPush', () => {
  it('unregisters the authenticated paired device', async () => {
    const unregisterPush = method('notifications.unregisterPush')
    const ctx = contextFor({ clientKind: 'mobile', pairedDeviceId: 'device-1' })

    expect(await unregisterPush.handler(undefined, ctx)).toEqual({ unregistered: true })
    expect(ctx.runtime.unregisterMobilePushDevice).toHaveBeenCalledWith('device-1')
  })

  it('refuses a non-mobile caller', async () => {
    const unregisterPush = method('notifications.unregisterPush')
    const ctx = contextFor({ clientKind: 'runtime', pairedDeviceId: 'device-1' })

    expect(await unregisterPush.handler(undefined, ctx)).toEqual({ unregistered: false })
    expect(ctx.runtime.unregisterMobilePushDevice).not.toHaveBeenCalled()
  })
})

describe('revokeMobileDevice', () => {
  it('queues the gateway delete before the device row disappears', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-push-revoke-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: false
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('phone', 'mobile')
    server['deviceRegistry']!.setPushRegistration(device.deviceId, {
      registrationId: 'reg-1',
      platform: 'android',
      filter: { sources: ['agent-task-complete'], agentStates: ['finished'] },
      registeredAt: 1
    })

    expect(await server.revokeMobileDevice(device.deviceId)).toBe(true)
    expect(server.getPushUnregisterOutbox().pending()).toEqual([
      expect.objectContaining({ registrationId: 'reg-1', deviceId: device.deviceId })
    ])
  })

  it('queues nothing for a device that never enabled push', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-push-revoke-'))
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: false
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('phone', 'mobile')

    expect(await server.revokeMobileDevice(device.deviceId)).toBe(true)
    expect(server.getPushUnregisterOutbox().pending()).toEqual([])
  })
})
