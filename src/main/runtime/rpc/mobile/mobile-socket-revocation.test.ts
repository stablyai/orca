// A socket whose device is removed on disk must not keep receiving a stream it subscribed to.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../server/pairing/device-registry'
import { DEVICE_REGISTRY_FILENAME } from '../server/pairing/mobile-pairing-files'
import { mobileSocketHarness } from './mobile-socket-wiring.test-fixture'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-socket-revocation-'))
  vi.useFakeTimers({ toFake: ['performance'] })
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

it('closes a subscribed socket before its next output once its row is removed on disk', () => {
  const registry = new DeviceRegistry(dir)
  const desktop = registry.addDevice('desktop', 'runtime')
  const { connect, requests } = mobileSocketHarness(registry)
  const { ws, request } = connect(() => ({ deviceToken: desktop.token }))
  request(JSON.stringify({ id: '1', method: 'terminal.subscribe' }))
  const [subscription] = requests
  const sentBeforeRevoke = ws.sent.length

  const path = join(dir, DEVICE_REGISTRY_FILENAME)
  const rows: { deviceId: string }[] = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify(rows.filter((row) => row.deviceId !== desktop.deviceId)))
  vi.advanceTimersByTime(1000)
  subscription!.reply(JSON.stringify({ id: '1', result: { data: 'output after revoke' } }))

  expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized')
  expect(ws.sent.length).toBe(sentBeforeRevoke)
})
