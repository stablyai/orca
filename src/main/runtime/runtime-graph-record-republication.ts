/** No-op graph publication must not replace records held by an outgoing admission. */
export function retainUnchangedGraphRecord<T extends object>(previous: T | undefined, next: T): T {
  if (!previous) {
    return next
  }
  const keys = Object.keys(next) as (keyof T)[]
  return Object.keys(previous).length === keys.length &&
    keys.every((key) => Object.hasOwn(previous, key) && Object.is(previous[key], next[key]))
    ? previous
    : next
}
