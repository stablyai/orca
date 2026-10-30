import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import {
  integrationRows as rows,
  integrationDeadline as deadline
} from './push-owner-bridge.test-fixture'
import { deriveRelayHostId } from '../mobile-cloud-relay/relay-http-client'
import { join } from 'node:path'
import { DeviceRegistry } from '../device-registry'
import { RuntimeMobileNotificationController } from '../runtime-mobile-notification-controller'
import { PushUnregisterOutbox } from './push-unregister-outbox'
import { DesktopPushService } from './desktop-push-service'
import { PushGatewayClient } from './push-gateway-client'
import { createPushHostKeypair } from './push-host-challenge-fixtures'
import { NotificationRegisterPushParams } from '../../../shared/rpc-contract/notifications-params'
import { record, text } from '../../../../cloud/apps/push/src/push-owner-integration.test-fixture'

export function desktopActors(
  path: string,
  transport: (host: string, url: string, init?: RequestInit) => Promise<Response>
) {
  const actors = ['A', 'B'].map((id) => {
    const registry = new DeviceRegistry(join(path, id))
    const device = registry.addDevice('synthetic integration phone', 'mobile')
    const controller = new RuntimeMobileNotificationController()
    const keypair = createPushHostKeypair()
    const outbox = new PushUnregisterOutbox(join(path, id))
    const client = new PushGatewayClient({
      gatewayUrl: 'https://push.onorca.dev',
      keypair,
      fetch: (url, init) => transport(id, String(url), init)
    })
    const service = DesktopPushService.create({
      runtime: {
        setMobilePushOrigin: controller.setPushOrigin.bind(controller),
        setMobilePushRegistrar: controller.setPushRegistrar.bind(controller),
        onNotificationDispatched: controller.onDispatched.bind(controller)
      },
      runtimeRpc: {
        getE2EEKeypair: () => keypair,
        getDeviceRegistry: () => registry,
        getPushUnregisterOutbox: () => outbox,
        setOnPushUnregisterQueued: () => {}
      },
      gatewayUrl: 'https://push.onorca.dev',
      client
    })
    if (!service) {
      throw new Error('Actual desktop service did not start')
    }
    service.start()
    return { id, registry, device, controller, service, keypair }
  })
  const source = actors.find((actor) => actor.id === 'B')
  if (!source) {
    throw new Error('Missing actual origin actor')
  }
  const origin = deriveRelayHostId(source.keypair.publicKey)
  return {
    origin,
    fingerprints: actors.map((actor) => deriveRelayHostId(actor.keypair.publicKey)).sort(),
    profiles: actors.map((actor) => ({
      id: actor.id,
      name: actor.id,
      endpoint: 'ws://127.0.0.1:1',
      lastConnected: 0,
      publicKeyB64: actor.keypair.publicKeyB64
    })),
    async rpc(value: Record<string, unknown>) {
      const host = text(value.host)
      const actor = actors.find((candidate) => candidate.id === host)
      if (!actor) {
        throw new Error('Unknown paired fixture host')
      }
      const method = text(value.method)
      if (method === 'status.get') {
        return { capabilities: ['notifications.remote-push.v1', 'notifications.push-route-key.v1'] }
      }
      if (method === 'notifications.registerPush') {
        const params = NotificationRegisterPushParams.parse(value.params)
        return actor.controller.registerPushDevice({ ...params, deviceId: actor.device.deviceId })
      }
      if (method === 'notifications.unregisterPush') {
        return actor.controller.unregisterPushDevice(actor.device.deviceId)
      }
      throw new Error(`Unexpected actual mobile method ${method}`)
    },
    dispatch(occurrence: string) {
      for (const actor of actors) {
        actor.controller.dispatch({
          type: 'notification',
          source: 'agent-task-complete',
          agentState: 'done',
          origin,
          occurrence,
          notificationId: `same-decision-${occurrence}`,
          title: 'Complete',
          body: 'Ready',
          desktopAway: true
        })
      }
    },
    registered() {
      return actors.map((actor) =>
        record(actor.registry.getDevice(actor.device.deviceId)?.pushRegistration ?? {})
      )
    },
    stop() {
      const failures: unknown[] = []
      for (const actor of actors) {
        try {
          actor.service.stop()
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Desktop actor cleanup failed')
      }
    }
  }
}

export async function settleOwnerDelivery(
  ports: {
    actors: ReturnType<typeof desktopActors>
    sent(occurrence: string): Promise<unknown>
    cloud(op: string): Promise<unknown>
    advance(delta: number): Promise<unknown>
  },
  label: string,
  expected: number,
  token: string
) {
  const { actors, cloud, advance } = ports
  const occurrence = createHash('sha256').update(label).digest('base64url')
  actors.dispatch(occurrence)
  await ports.sent(occurrence)
  await cloud('flush')
  await advance(1000)
  await cloud('flush')
  const snapshot = record(await cloud('snapshot'))
  const providers = rows(snapshot.providers)
  expect(providers).toHaveLength(expected)
  const provider = providers.at(-1)
  if (!provider) {
    throw new Error('No actual final provider request')
  }
  expect(provider.path).toBe(`/3/device/${token}`)
  expect(record(record(JSON.parse(text(provider.body))).orca)).toMatchObject({
    origin: actors.origin,
    occurrence
  })
  expect(rows(snapshot.claims).filter((claim) => claim.state === 'sent')).toHaveLength(expected)
  expect(rows(snapshot.pending)).toEqual([])
  if (!Array.isArray(snapshot.decisions)) {
    throw new Error('Missing actual admission observations')
  }
  expect(snapshot.decisions.filter((decision) => decision === 'admitted')).toHaveLength(expected)
  expect(snapshot.decisions.filter((decision) => decision === 'superseded')).toHaveLength(expected)
  expect(rows(snapshot.recipients)).toHaveLength(expected * 2)
  return snapshot
}

export function expectOwnerEnrollment(
  snapshot: Record<string, unknown>,
  token: string,
  routeKey: unknown
): void {
  expect(rows(snapshot.devices)).toHaveLength(2)
  expect(
    rows(snapshot.devices).every(
      (device) => device.token === token && device.route_key === routeKey
    )
  ).toBe(true)
  expect(rows(snapshot.claims).every((claim) => claim.winner_route_key === routeKey)).toBe(true)
}

export function ownerCapacityPhase(ports: {
  mobile(op: string): Promise<unknown>
  cloud(op: string): Promise<unknown>
  event(name: string, data?: unknown): void
  wait(name: string): Promise<unknown>
}) {
  const held = Promise.withResolvers<void>()
  let pending = false
  return {
    release: () => held.resolve(),
    async before(value: Record<string, unknown>) {
      if (
        pending &&
        text(value.url).endsWith('/v1/routes') &&
        record(JSON.parse(text(value.body))).action === 'replace'
      ) {
        ports.event('cap replace pending before commit')
        await held.promise
      }
    },
    accepted(declaration: Record<string, unknown>) {
      if (Array.isArray(declaration.hosts)) {
        ports.event(`capacity:${declaration.hosts.length}`, declaration)
      }
    },
    async run(fingerprints: readonly string[]) {
      await ports.mobile('restore-cap-catalog')
      const prior100 = record(
        await deadline(ports.wait('capacity:100'), 'actual signed prior P100')
      )
      if (!Array.isArray(prior100.hosts)) {
        throw new Error('Missing actual P100')
      }
      expect(new Set(prior100.hosts).size).toBe(100)
      pending = true
      const mutations = ports.mobile('mutate-cap-catalog')
      await deadline(
        ports.wait('cap replace pending before commit'),
        'issued older capacity proposal'
      )
      await mutations // local metadata actions never await route acknowledgement
      held.resolve()
      pending = false
      const retained99 = record(
        await deadline(ports.wait('capacity:99'), 'actual current retained99 replacement')
      )
      const members = retained99.hosts
      if (!Array.isArray(members)) {
        throw new Error('Missing actual retained set')
      }
      expect(fingerprints.every((host) => members.includes(host))).toBe(true)
      const snapshot = record(await ports.cloud('snapshot'))
      expect(
        rows(snapshot.declarations).some(
          (row) =>
            row.version === retained99.version && JSON.parse(text(row.hosts_json)).length === 99
        )
      ).toBe(true)
    }
  }
}
