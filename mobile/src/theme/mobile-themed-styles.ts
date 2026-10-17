import { getMobileColorScheme, type MobileColorScheme } from './mobile-theme'

/** Keep existing named styles, with stable native style objects for each palette. */
export function createThemedStyles<T extends object>(create: () => T): T {
  const variants = new Map<MobileColorScheme, T>()
  const read = (): T => {
    const scheme = getMobileColorScheme()
    let value = variants.get(scheme)
    if (!value) {
      value = create()
      variants.set(scheme, value)
    }
    return value
  }
  return new Proxy(
    { ...read() },
    {
      get: (_, key) => Reflect.get(read(), key)
    }
  )
}
