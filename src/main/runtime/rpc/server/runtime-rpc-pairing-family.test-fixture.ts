import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeviceRegistry } from './pairing/device-registry'
import type { DeviceEntry } from './pairing/device-entry'
import { DEVICE_REGISTRY_FILENAME } from './pairing/mobile-pairing-files'

export function seedRuntimePairingFamily(directory: string, withAncestor = true) {
  const registry = new DeviceRegistry(directory)
  const parent = registry.addDevice('Ancestor', 'runtime')
  // Pair the parent so advertising the child's offer cannot reuse its pending credential.
  registry.updateLastSeen(parent.deviceId)
  const child = registry.addDevice('Browser', 'runtime')
  if (withAncestor) {
    const path = join(directory, DEVICE_REGISTRY_FILENAME)
    const rows: DeviceEntry[] = JSON.parse(readFileSync(path, 'utf8'))
    writeFileSync(
      path,
      JSON.stringify(
        rows.map((row) =>
          row.deviceId === child.deviceId ? { ...row, parentDeviceId: parent.deviceId } : row
        )
      )
    )
  }
  return { parent, child }
}
