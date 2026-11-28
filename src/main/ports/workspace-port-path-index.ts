import type { NormalizedWorkspacePortProbe } from './local-workspace-port-scan-state'

type IndexedProbe = { probe: NormalizedWorkspacePortProbe; order: number }
type PathNode = {
  singleSymbol?: number
  singleChild?: PathNode
  children?: Map<number, PathNode>
  value?: IndexedProbe
  failure?: PathNode
  best?: IndexedProbe
}

function isAsciiWhitespace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}

function isPathStartBoundary(text: string, index: number): boolean {
  if (index === 0) {
    return true
  }
  const code = text.charCodeAt(index - 1)
  if (code < 128) {
    return isAsciiWhitespace(code) || code === 34 || code === 39 || code === 61
  }
  return /\s/.test(text[index - 1])
}

function isCommandEndBoundary(text: string, index: number): boolean {
  if (index >= text.length) {
    return true
  }
  const code = text.charCodeAt(index)
  if (code < 128) {
    return isAsciiWhitespace(code) || code === 34 || code === 39 || code === 47 || code === 58
  }
  return /\s/.test(text[index])
}

// Encode valid starts so suffix winners never need a separate boundary-filter walk.
function pathSymbolAt(text: string, index: number): number {
  return text.charCodeAt(index) + (isPathStartBoundary(text, index) ? 0x10000 : 0)
}

function getChild(node: PathNode, symbol: number): PathNode | undefined {
  if (node.children) {
    return node.children.get(symbol)
  }
  return node.singleSymbol === symbol ? node.singleChild : undefined
}

function getOrCreateChild(node: PathNode, symbol: number): PathNode {
  if (node.children) {
    let child = node.children.get(symbol)
    if (!child) {
      child = {}
      node.children.set(symbol, child)
    }
    return child
  }
  if (node.singleChild === undefined) {
    const child: PathNode = {}
    node.singleSymbol = symbol
    node.singleChild = child
    return child
  }
  if (node.singleSymbol === symbol) {
    return node.singleChild
  }
  const children = new Map<number, PathNode>()
  children.set(node.singleSymbol!, node.singleChild)
  const child: PathNode = {}
  children.set(symbol, child)
  node.children = children
  node.singleSymbol = undefined
  node.singleChild = undefined
  return child
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
  private readonly root: PathNode = {}
  private commandPrepared = false

  constructor(probes: readonly NormalizedWorkspacePortProbe[]) {
    for (let order = 0; order < probes.length; order++) {
      const probe = probes[order]
      let node = this.root
      for (let i = 0; i < probe.normalizedPath.length; i++) {
        node = getOrCreateChild(node, pathSymbolAt(probe.normalizedPath, i))
      }
      node.value ??= { probe, order }
    }
  }

  findCwd(cwd: string): NormalizedWorkspacePortProbe | undefined {
    let node = this.root
    let best: IndexedProbe | undefined
    for (let i = 0; i < cwd.length; i++) {
      const child = getChild(node, pathSymbolAt(cwd, i))
      if (!child) {
        break
      }
      node = child
      if (node.value && (i + 1 === cwd.length || cwd.charCodeAt(i + 1) === 47)) {
        best = node.value
      }
    }
    return best?.probe
  }

  findCommand(command: string): NormalizedWorkspacePortProbe | undefined {
    if (
      command.length === 0 ||
      (this.root.singleChild === undefined && !this.root.children?.size)
    ) {
      return undefined
    }
    this.prepareCommandMatches()
    let node = this.root
    let best: IndexedProbe | undefined
    for (let i = 0; i < command.length; i++) {
      const symbol = pathSymbolAt(command, i)
      let next = getChild(node, symbol)
      while (!next && node !== this.root) {
        node = node.failure ?? this.root
        next = getChild(node, symbol)
      }
      node = next ?? this.root
      if (node.best && isCommandEndBoundary(command, i + 1)) {
        best = preferredProbe(best, node.best)
      }
    }
    return best?.probe
  }

  private prepareCommandMatches(): void {
    if (this.commandPrepared) {
      return
    }
    const queue: PathNode[] = []
    if (this.root.singleChild !== undefined) {
      this.root.singleChild.failure = this.root
      this.root.singleChild.best = this.root.singleChild.value
      queue.push(this.root.singleChild)
    } else if (this.root.children) {
      for (const child of this.root.children.values()) {
        child.failure = this.root
        child.best = child.value
        queue.push(child)
      }
    }
    const linkChild = (node: PathNode, symbol: number, child: PathNode): void => {
      let fallback = node.failure ?? this.root
      let suffix = getChild(fallback, symbol)
      while (!suffix && fallback !== this.root) {
        fallback = fallback.failure ?? this.root
        suffix = getChild(fallback, symbol)
      }
      child.failure = suffix ?? this.root
      child.best = preferredProbe(child.value, child.failure.best)
      queue.push(child)
    }
    for (let i = 0; i < queue.length; i++) {
      const node = queue[i]
      if (node.singleChild !== undefined) {
        linkChild(node, node.singleSymbol!, node.singleChild)
      } else if (node.children) {
        for (const [symbol, child] of node.children) {
          linkChild(node, symbol, child)
        }
      }
    }
    this.commandPrepared = true
  }
}
