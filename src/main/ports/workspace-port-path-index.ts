import type { NormalizedWorkspacePortProbe } from './local-workspace-port-scan-state'

type IndexedProbe = { probe: NormalizedWorkspacePortProbe; order: number }
type PathNode = {
  children: Map<number, PathNode>
  value?: IndexedProbe
  failure?: PathNode
  best?: IndexedProbe
}

// Encode valid starts so suffix winners never need a separate boundary-filter walk.
function pathSymbolAt(text: string, index: number): number {
  const boundary = index === 0 || /[\s"'=]/.test(text[index - 1])
  return text.charCodeAt(index) + (boundary ? 0x10000 : 0)
}

function preferredProbe(
  current: IndexedProbe | undefined,
  candidate: IndexedProbe | undefined
): IndexedProbe | undefined {
  if (
    candidate &&
    (!current ||
      candidate.probe.normalizedPath.length > current.probe.normalizedPath.length ||
      (candidate.probe.normalizedPath.length === current.probe.normalizedPath.length &&
        candidate.order < current.order))
  ) {
    return candidate
  }
  return current
}

export class WorkspacePortPathIndex {
  private readonly root: PathNode = { children: new Map() }
  private commandPrepared = false

  constructor(probes: readonly NormalizedWorkspacePortProbe[]) {
    probes.forEach((probe, order) => {
      let node = this.root
      for (let i = 0; i < probe.normalizedPath.length; i++) {
        const symbol = pathSymbolAt(probe.normalizedPath, i)
        let child = node.children.get(symbol)
        if (!child) {
          child = { children: new Map() }
          node.children.set(symbol, child)
        }
        node = child
      }
      node.value ??= { probe, order }
    })
  }

  findCwd(cwd: string): NormalizedWorkspacePortProbe | undefined {
    let node = this.root
    let best: IndexedProbe | undefined
    for (let i = 0; i < cwd.length; i++) {
      const child = node.children.get(pathSymbolAt(cwd, i))
      if (!child) {
        break
      }
      node = child
      if (node.value && (i + 1 === cwd.length || cwd[i + 1] === '/')) {
        best = node.value
      }
    }
    return best?.probe
  }

  findCommand(command: string): NormalizedWorkspacePortProbe | undefined {
    if (command.length === 0 || this.root.children.size === 0) {
      return undefined
    }
    this.prepareCommandMatches()
    let node = this.root
    let best: IndexedProbe | undefined
    for (let i = 0; i < command.length; i++) {
      const symbol = pathSymbolAt(command, i)
      let next = node.children.get(symbol)
      while (!next && node !== this.root) {
        node = node.failure ?? this.root
        next = node.children.get(symbol)
      }
      node = next ?? this.root
      if (node.best && (i + 1 === command.length || /[\s"'/:]/.test(command[i + 1]))) {
        best = preferredProbe(best, node.best)
      }
    }
    return best?.probe
  }

  private prepareCommandMatches(): void {
    if (this.commandPrepared) {
      return
    }
    const queue = [...this.root.children.values()]
    for (const child of queue) {
      child.failure = this.root
      child.best = child.value
    }
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]
      for (const [symbol, child] of node.children) {
        let fallback = node.failure ?? this.root
        let suffix = fallback.children.get(symbol)
        while (!suffix && fallback !== this.root) {
          fallback = fallback.failure ?? this.root
          suffix = fallback.children.get(symbol)
        }
        child.failure = suffix ?? this.root
        child.best = preferredProbe(child.value, child.failure.best)
        queue.push(child)
      }
    }
    this.commandPrepared = true
  }
}
