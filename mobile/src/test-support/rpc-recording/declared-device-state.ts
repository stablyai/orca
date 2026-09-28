import { nativeStoreModule, partialNativeModule } from './native-module-traps'

/**
 * What a recording declares about the device it runs on.
 *
 * Undeclared is unchanged: async storage stays the throwing store and expo-notifications stays an
 * unlisted package. Declaring one swaps in a backing that answers only from the declaration, so
 * every byte a read can return is visible in the scenario file. Writes never feed back into reads —
 * a read that could return a byte nothing declared would put the device back inside the recording.
 * They are recorded as effects instead, which is where an unobserved write becomes observable.
 */
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

/**
 * The substitutes a scenario's declarations back, and the sink its writes are recorded through.
 * The sink is bound at mount because the effect recorder belongs to one run, while the loader that
 * holds the substitutes is built before it; an unbound write is a bug rather than a silent drop.
 */
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
    // Namespace-imported by every consumer, so the marker keeps reads going through the trap; see
    // the `__esModule` paragraph in `native-module-traps.ts`.
    __esModule: true,
    // Cloned per read, so a screen that mutates a notification cannot change what the next read of
    // the declaration returns.
    getPresentedNotificationsAsync: () => Promise.resolve(structuredClone(tray)),
    dismissNotificationAsync: (identifier: string) => {
      effect('notification-tray.dismiss', { identifier })
      return Promise.resolve()
    }
  })
}
