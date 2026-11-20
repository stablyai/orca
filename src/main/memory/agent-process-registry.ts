// Native agent CLIs (chat providers, app servers) run outside terminals, under main or the agent host.
const roots = new Map<number, number>()

/** Counts this provider root's process tree as agent memory until the returned release runs. */
export function registerAgentProcess(pid: number): () => void {
  roots.set(pid, (roots.get(pid) ?? 0) + 1)
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    const count = (roots.get(pid) ?? 1) - 1
    if (count > 0) {
      roots.set(pid, count)
    } else {
      roots.delete(pid)
    }
  }
}

export function listAgentProcessPids(): number[] {
  return [...roots.keys()]
}
