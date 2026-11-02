/** Strongly connected components preserve corrupt cycles while reducing proven acyclic successors. */
export function maximalCrewClaims(
  keys: string[],
  successors: ReadonlyMap<string, ReadonlySet<string>>
): Set<string> {
  const reverse = new Map<string, string[]>()
  for (const [from, targets] of successors) {
    for (const to of targets) {
      const previous = reverse.get(to) ?? []
      previous.push(from)
      reverse.set(to, previous)
    }
  }
  const visited = new Set<string>()
  const finished: string[] = []
  for (const key of keys) {
    const stack: { key: string; finish: boolean }[] = [{ key, finish: false }]
    while (stack.length) {
      const next = stack.pop()!
      if (next.finish) {
        finished.push(next.key)
      } else if (!visited.has(next.key)) {
        visited.add(next.key)
        stack.push({ ...next, finish: true })
        for (const target of successors.get(next.key) ?? []) {
          if (!visited.has(target)) {
            stack.push({ key: target, finish: false })
          }
        }
      }
    }
  }
  const component = new Map<string, number>()
  let count = 0
  for (const key of finished.toReversed()) {
    if (component.has(key)) {
      continue
    }
    const stack = [key]
    component.set(key, count)
    while (stack.length) {
      for (const previous of reverse.get(stack.pop()!) ?? []) {
        if (!component.has(previous)) {
          component.set(previous, count)
          stack.push(previous)
        }
      }
    }
    count++
  }
  const sizes = new Map<number, number>()
  for (const id of component.values()) {
    sizes.set(id, (sizes.get(id) ?? 0) + 1)
  }
  return new Set(
    keys.filter(
      (key) =>
        sizes.get(component.get(key)!)! > 1 ||
        ![...(successors.get(key) ?? [])].some((next) => component.get(next) !== component.get(key))
    )
  )
}
