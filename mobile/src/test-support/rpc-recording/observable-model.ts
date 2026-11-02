import type { MountContext } from './recording-scenario'

export function projectObservable(value: unknown): unknown {
  if (value instanceof Set) {
    return [...value].map(projectObservable)
  }
  if (value instanceof Map) {
    return [...value].map(([key, entry]) => [key, projectObservable(entry)])
  }
  if (Array.isArray(value)) {
    return value.map(projectObservable)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        key === 'client' ? 'logical-client' : projectObservable(entry)
      ])
    )
  }
  return value
}

export function observableModel(context: MountContext, initial: Record<string, unknown>) {
  const values = { ...initial }
  const callbacks = new Map<string, (value: unknown) => void>()
  return new Proxy(values, {
    get(target, key: string) {
      if (key in target) {
        return target[key]
      }
      if (!key.startsWith('set') || key.length < 4) {
        throw new Error(`Missing model fixture: ${key}`)
      }
      if (!callbacks.has(key)) {
        const field = key[3].toLowerCase() + key.slice(4)
        callbacks.set(key, (value) => {
          target[field] = typeof value === 'function' ? value(target[field]) : value
          context.effect(field, projectObservable(target[field]))
        })
      }
      return callbacks.get(key)
    }
  })
}
