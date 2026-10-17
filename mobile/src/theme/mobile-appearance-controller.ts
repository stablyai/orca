import type { MobileColorScheme } from './mobile-theme'

export type MobileAppearance = 'system' | MobileColorScheme
export type MobileAppearanceSnapshot = {
  preference: MobileAppearance
  ready: boolean
  error: string | null
}
export function parseMobileAppearance(value: unknown): MobileAppearance {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function createMobileAppearanceController(deps: {
  read: () => Promise<unknown>
  write: (value: MobileAppearance) => Promise<void>
  systemScheme: () => string | null | undefined
  onSystemChange: (listener: () => void) => () => void
  setNativePreference?: (preference: MobileAppearance) => void
  apply: (scheme: MobileColorScheme) => void
}) {
  let state: MobileAppearanceSnapshot = { preference: 'system', ready: false, error: null }
  let persisted: MobileAppearance = 'system'
  let persistedRevision = -1
  let revision = 0
  let writes: Promise<void> = Promise.resolve()
  let startup: Promise<void> | null = null
  const listeners = new Set<() => void>()
  const apply = () => {
    deps.setNativePreference?.(state.preference)
    deps.apply(
      state.preference === 'system'
        ? deps.systemScheme() === 'dark'
          ? 'dark'
          : 'light'
        : state.preference
    )
  }
  const publish = (next: MobileAppearanceSnapshot) => {
    state = next
    apply()
    for (const listener of listeners) {
      listener()
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    start() {
      if (!startup) {
        deps.onSystemChange(apply)
        const startedAt = revision
        startup = deps.read().then(
          (value) => {
            if (persistedRevision < startedAt) {
              persisted = parseMobileAppearance(value)
            }
            publish({
              ...state,
              ready: true,
              preference:
                revision === startedAt || state.error !== null ? persisted : state.preference
            })
          },
          () => publish({ ...state, ready: true })
        )
      }
      return startup
    },
    setPreference(preference: MobileAppearance) {
      const current = ++revision
      publish({ ...state, preference, error: null })
      const write = writes.then(() => deps.write(preference))
      writes = write.then(
        () => {
          persisted = preference
          persistedRevision = current
        },
        () => {
          if (revision === current) {
            publish({
              ...state,
              preference: persisted,
              error: 'Could not save appearance. Try again.'
            })
          }
        }
      )
      return writes
    }
  }
}
