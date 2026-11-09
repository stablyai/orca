import type { NormalizedWorkspacePortProbe } from './local-workspace-port-scan-state'

type IndexedProbe = { probe: NormalizedWorkspacePortProbe; order: number }
type PathNode = { children: Map<string, PathNode>; value?: IndexedProbe }

export class WorkspacePortPathIndex {
  private readonly root: PathNode = { children: new Map() }

  constructor(probes: readonly NormalizedWorkspacePortProbe[]) {
    probes.forEach((probe, order) => {
      let node = this.root
      for (let i = 0; i < probe.normalizedPath.length; i++) {
        const character = probe.normalizedPath[i]
        let child = node.children.get(character)
        if (!child) {
          child = { children: new Map() }
          node.children.set(character, child)
        }
        node = child
      }
      node.value ??= { probe, order }
    })
  }

  findCwd(cwd: string): NormalizedWorkspacePortProbe | undefined {
    return this.findPrefix(cwd, 0, false)?.probe
  }

  findCommand(command: string): NormalizedWorkspacePortProbe | undefined {
    if (this.root.children.size === 0) {
      return undefined
    }
    let best: IndexedProbe | undefined
    for (let start = 0; start < command.length; start++) {
      if (
        !this.root.children.has(command[start]) ||
        (start > 0 && !/[\s"'=]/.test(command[start - 1]))
      ) {
        continue
      }
      const found = this.findPrefix(command, start, true)
      if (
        found &&
        (!best ||
          found.probe.normalizedPath.length > best.probe.normalizedPath.length ||
          (found.probe.normalizedPath.length === best.probe.normalizedPath.length &&
            found.order < best.order))
      ) {
        best = found
      }
    }
    return best?.probe
  }

  private findPrefix(text: string, start: number, command: boolean): IndexedProbe | undefined {
    let node = this.root
    let best: IndexedProbe | undefined
    for (let i = start; i < text.length; i++) {
      const child = node.children.get(text[i])
      if (!child) {
        break
      }
      node = child
      const after = text[i + 1]
      if (
        node.value &&
        (after === undefined || (command ? /[\s"'/:]/.test(after) : after === '/'))
      ) {
        best = node.value
      }
    }
    return best
  }
}
