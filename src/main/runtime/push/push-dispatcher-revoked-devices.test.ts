// A phone whose authority was removed on disk gets no further notification content.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../rpc/server/pairing/device-registry'
import { DEVICE_REGISTRY_FILENAME } from '../rpc/server/pairing/mobile-pairing-files'
import { PushDispatcher } from './push-dispatcher'
import { flush, notification, registration, type SendCall } from './push-dispatcher.test-fixture'
import type { PushGatewayClient } from './push-gateway-client'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-push-revoked-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('sends nothing to a delegated phone once its desktop is removed on disk', async () => {
  const registry = new DeviceRegistry(dir)
  const desktop = registry.addDevice('desktop', 'runtime')
  registry.updateLastSeen(desktop.deviceId)
  const [phone] = registry.upsertDelegatedMobileDevices(desktop, [
    { phoneKey: 'phone-1', name: 'Pixel' }
  ])
  registry.setPushRegistration(phone!.deviceId, registration())
  const sends: SendCall[] = []
  const client = {
    send: vi.fn(async (input: SendCall) => {
      sends.push(input)
      return { ok: true as const, results: [] }
    })
  } as unknown as PushGatewayClient
  const dispatcher = new PushDispatcher({ client, registry })

  const path = join(dir, DEVICE_REGISTRY_FILENAME)
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== desktop.deviceId)))
  dispatcher.enqueue(notification())
  await flush()

  expect(sends).toEqual([])
})
