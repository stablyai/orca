import { resolve, relative, isAbsolute } from 'path'

// Why: mutating FS operations on the remote must be scoped to workspace roots
// registered by the main process. Without this, a compromised or buggy client
// could delete arbitrary files on the remote host.
export class RelayContext {
  readonly authorizedRoots = new Set<string>()

  registerRoot(rootPath: string): void {
    this.authorizedRoots.add(resolve(rootPath))
  }

  validatePath(targetPath: string): void {
    // Why: before any repo is opened, no roots are registered. We allow all
    // operations in this state so relay deployment and initial setup work.
    if (this.authorizedRoots.size === 0) {
      return
    }

    const resolved = resolve(targetPath)
    for (const root of this.authorizedRoots) {
      const rel = relative(root, resolved)
      if (!rel.startsWith('..') && !isAbsolute(rel)) {
        return
      }
    }
    throw new Error(`Path outside authorized workspace: ${targetPath}`)
  }
}
