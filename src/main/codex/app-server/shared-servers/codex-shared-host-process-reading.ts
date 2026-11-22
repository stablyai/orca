/** Concurrent callers share one reading, and each reading starts after every request it serves,
 *  so a check made after a kill never gets a table read before it. One reading runs at a time,
 *  so many chats closing at once (quit, account switch) cost a few host reads, not one each. */
export function coalescedReading<T>(read: () => Promise<T>): () => Promise<T> {
  let running: Promise<unknown> = Promise.resolve()
  let next: Promise<T> | null = null
  return () => {
    if (!next) {
      const reading = running.then(() => {
        next = null
        return read()
      })
      next = reading
      running = reading.catch(() => {})
    }
    return next
  }
}

export function childrenByParent(
  parents: Iterable<readonly [number, number | null]>
): Map<number, number[]> {
  const children = new Map<number, number[]>()
  for (const [pid, parent] of parents) {
    if (parent !== null) {
      const siblings = children.get(parent)
      if (siblings) {
        siblings.push(pid)
      } else {
        children.set(parent, [pid])
      }
    }
  }
  return children
}

/** Every process below one, by parent links. */
export function descendants(children: ReadonlyMap<number, number[]>, root: number): number[] {
  const found: number[] = []
  const queue = [...(children.get(root) ?? [])]
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index]!
    found.push(pid)
    queue.push(...(children.get(pid) ?? []))
  }
  return found
}

/** The server's launcher chain down to the native Codex process; null when Codex isn't found. */
export function serverChain(
  processes: ReadonlyMap<number, { name: string }>,
  children: ReadonlyMap<number, number[]>,
  serverPid: number
): Set<number> | null {
  const parents = new Map<number, number>()
  const queue = [serverPid]
  for (let index = 0; index < queue.length; index += 1) {
    const pid = queue[index]!
    if (/^codex/i.test(processes.get(pid)?.name ?? '')) {
      const chain = new Set<number>()
      for (let at: number | undefined = pid; at !== undefined; at = parents.get(at)) {
        chain.add(at)
      }
      return chain
    }
    for (const child of children.get(pid) ?? []) {
      parents.set(child, pid)
      queue.push(child)
    }
  }
  return null
}
