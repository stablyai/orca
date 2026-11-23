import { resolve } from 'node:path'

const pending = new Map<string, Promise<unknown>>()

export function serializeClaudeAgentViewConfig<T>(
  configPath: string,
  run: () => Promise<T>
): Promise<T> {
  const key = resolve(configPath)
  const previous = pending.get(key) ?? Promise.resolve()
  const next = previous
    .catch(() => {})
    .then(run)
    .finally(() => {
      if (pending.get(key) === next) {
        pending.delete(key)
      }
    })
  pending.set(key, next)
  return next
}
