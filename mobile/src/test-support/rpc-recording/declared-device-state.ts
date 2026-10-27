import { nativeStoreModule, partialNativeModule } from './native-module-traps'

// Only declarations back device reads; writes become effects and never feed undeclared bytes into later reads.
// Undeclared storage still throws and notifications remain unlisted.
type DeclaredNotification = {
  readonly request: {
    readonly identifier: string
    readonly content: { readonly data?: unknown }
    readonly trigger?: unknown
  }
}
export type DeclaredDeviceState = {
  readonly deviceStore?: Readonly<Record<string, string>>
  readonly deviceState?: { readonly notificationTray?: readonly DeclaredNotification[] }
}
type DeviceEffect = (name: string, value: unknown) => void

// Bind writes at mount because the loader precedes the run’s effect recorder; an unbound write must fail.
export function declaredDeviceSubstitutes(declared: DeclaredDeviceState): {
  substitutes: ReadonlyMap<string, unknown>
  bind: (effect: DeviceEffect) => void
} {
  let sink: DeviceEffect | undefined
  const effect: DeviceEffect = (name, value) => {
    if (!sink) {
      throw new Error(`Declared device effect before mount: ${name}`)
    }
    sink(name, value)
  }
  const substitutes = new Map<string, unknown>()
  const store = declared.deviceStore
  if (store) {
    substitutes.set('@react-native-async-storage/async-storage', declaredDeviceStore(store, effect))
  }
  const tray = declared.deviceState?.notificationTray
  if (tray) {
    substitutes.set('expo-notifications', declaredNotificationTray(tray, effect))
  }
  return {
    substitutes,
    bind: (bound) => {
      sink = bound
    }
  }
}

function declaredDeviceStore(
  entries: Readonly<Record<string, string>>,
  effect: DeviceEffect
): unknown {
  return nativeStoreModule('@react-native-async-storage/async-storage', {
    getItem: (key: string) => Promise.resolve(entries[key] ?? null),
    setItem: (key: string, value: string) => {
      effect('device-store.setItem', { key, value })
      return Promise.resolve()
    },
    removeItem: (key: string) => {
      effect('device-store.removeItem', { key })
      return Promise.resolve()
    }
  })
}

function declaredNotificationTray(
  tray: readonly DeclaredNotification[],
  effect: DeviceEffect
): unknown {
  return partialNativeModule('expo-notifications', {
    // Preserve namespace-import traps with __esModule; see native-module-traps.ts.
    __esModule: true,
    // Clone each read so consumers cannot mutate the scenario’s declaration.
    getPresentedNotificationsAsync: () => Promise.resolve(structuredClone(tray)),
    dismissNotificationAsync: (identifier: string) => {
      effect('notification-tray.dismiss', { identifier })
      return Promise.resolve()
    }
  })
}
