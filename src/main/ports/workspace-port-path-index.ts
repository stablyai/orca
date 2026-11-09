import type { NormalizedWorkspacePortProbe } from './local-workspace-port-scan-state'

type IndexedProbe = { probe: NormalizedWorkspacePortProbe; order: number }

export class WorkspacePortPathIndex {
  private readonly roots = new Map<string, IndexedProbe>()
  private readonly rootStarts = new Set<string>()
  private maxRootLength = 0

  constructor(probes: readonly NormalizedWorkspacePortProbe[]) {
    probes.forEach((probe, order) => {
      if (!this.roots.has(probe.normalizedPath)) {
        this.roots.set(probe.normalizedPath, { probe, order })
        this.rootStarts.add(probe.normalizedPath[0])
        this.maxRootLength = Math.max(this.maxRootLength, probe.normalizedPath.length)
      }
    })
  }

  findCwd(cwd: string): NormalizedWorkspacePortProbe | undefined {
    const exact = this.roots.get(cwd)
    if (exact) {
      return exact.probe
    }
    for (let end = cwd.lastIndexOf('/'); end >= 0; end = cwd.lastIndexOf('/', end - 1)) {
      const found = this.roots.get(cwd.slice(0, end))
      if (found) {
        return found.probe
      }
      if (end === 0) {
        break
      }
    }
    return undefined
  }

  findCommand(command: string): NormalizedWorkspacePortProbe | undefined {
    let best: IndexedProbe | undefined
    for (let start = 0; start < command.length; start++) {
      if (
        !this.rootStarts.has(command[start]) ||
        (start > 0 && !/[\s"'=]/.test(command[start - 1]))
      ) {
        continue
      }
      const limit = Math.min(command.length, start + this.maxRootLength)
      for (let end = start + 1; end <= limit; end++) {
        if (end < command.length && !/[\s"'/:]/.test(command[end])) {
          continue
        }
        const found = this.roots.get(command.slice(start, end))
        if (
          found &&
          (!best ||
            end - start > best.probe.normalizedPath.length ||
            (end - start === best.probe.normalizedPath.length && found.order < best.order))
        ) {
          best = found
        }
      }
    }
    return best?.probe
  }
}
