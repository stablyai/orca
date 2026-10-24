/** Reorder the latest metadata by identity; keep new hosts at the end and ignore removed ids. */
export function orderHostsByIds<T extends { id: string }>(
  hosts: readonly T[],
  orderedIds: readonly string[]
): T[] {
  const remaining = new Map(hosts.map((host) => [host.id, host]))
  const next: T[] = []
  for (const id of orderedIds) {
    const host = remaining.get(id)
    if (host) {
      next.push(host)
      remaining.delete(id)
    }
  }
  next.push(...remaining.values())
  return next
}
