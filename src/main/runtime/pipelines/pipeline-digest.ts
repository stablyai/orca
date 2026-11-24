import { createHash } from 'node:crypto'

export function pipelineDigest(value: unknown): string {
  const canonical = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(canonical)
      : item !== null && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, canonical(child)])
          )
        : item
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
}
