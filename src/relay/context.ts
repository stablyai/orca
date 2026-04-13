import { resolve, relative, isAbsolute } from 'path'

// Why: mutating FS operations on the remote must be scoped to workspace roots
// registered by the main process. Without this, a compromised or buggy client
// could delete arbitrary files on the remote host.
export class RelayContext {
  readonly authorizedRoots = new Set<string>()

  // Why: before any root is registered there is a race window where
  // authorizedRoots is empty. If we allowed all paths during that window a
  // compromised client could read or mutate arbitrary files before the first
  // workspace root is registered. We track registration explicitly and reject
  // every validatePath call until at least one root has been added.
  private rootsRegistered = false

  registerRoot(rootPath: string): void {
    this.authorizedRoots.add(resolve(rootPath))
    this.rootsRegistered = true
  }

  validatePath(targetPath: string): void {
    // Why: reject all path validation before any root is registered to close
    // the race window between relay start and workspace root registration.
    if (!this.rootsRegistered) {
      throw new Error('No workspace roots registered yet — path validation denied')
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
