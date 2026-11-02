import { getEmulatorOpeningMode } from '../../shared/emulator-opening-preferences'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type {
  EmulatorDevicePreference,
  EmulatorSelectionRequired
} from '../../shared/emulator-opening-preferences'
import type { EmulatorDevice } from './backends/emulator-backend'

type Settings = Pick<
  GlobalSettings,
  'mobileEmulatorOpeningMode' | 'mobileEmulatorDefaultDeviceUdid' | 'mobileEmulatorRecentDevices'
>
export function emulatorDevicePreference(device: EmulatorDevice): EmulatorDevicePreference | null {
  const avd =
    device.backend === 'android' && (device.detail === 'emulator' || device.detail === 'avd')
  if (avd && device.id === device.name && device.id.startsWith('emulator-')) {
    return null
  }
  return {
    backend: device.backend,
    kind: avd ? 'avd' : 'device',
    id: avd ? device.name : device.id,
    name: device.name,
    lastUsedAt: new Date().toISOString()
  }
}

export function rememberEmulatorDevice(
  device: EmulatorDevice,
  recent: EmulatorDevicePreference[]
): EmulatorDevicePreference[] {
  const next = emulatorDevicePreference(device)
  if (!next) {
    return recent
  }
  return [
    next,
    ...recent.filter(
      (item) => item.backend !== next.backend || item.kind !== next.kind || item.id !== next.id
    )
  ].slice(0, 20)
}

export function resolveEmulatorOpeningPreference(
  settings: Settings,
  devices: EmulatorDevice[]
): { device: string } | { selectionRequired: EmulatorSelectionRequired } {
  const mode = getEmulatorOpeningMode(settings)
  if (mode === 'ask') {
    return { selectionRequired: 'ask' }
  }
  let candidate: EmulatorDevice | undefined
  if (mode === 'specific') {
    const target = settings.mobileEmulatorDefaultDeviceUdid
    if (!target) {
      return { selectionRequired: 'first-use' }
    }
    candidate = devices.find(
      (device) =>
        device.id === target ||
        (device.backend === 'android' &&
          ['avd', 'emulator'].includes(device.detail ?? '') &&
          device.name === target)
    )
  } else {
    const recent = settings.mobileEmulatorRecentDevices?.[0]
    if (!recent) {
      return { selectionRequired: 'first-use' }
    }
    candidate = devices.find((device) => {
      const identity = emulatorDevicePreference(device)
      return (
        identity?.backend === recent.backend &&
        identity.kind === recent.kind &&
        identity.id === recent.id
      )
    })
  }
  if (!candidate) {
    return { selectionRequired: 'missing' }
  }
  return candidate.isAvailable === false
    ? { selectionRequired: 'unavailable' }
    : { device: candidate.id }
}
