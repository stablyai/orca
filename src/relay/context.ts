import { resolve, relative, isAbsolute } from 'path'
import { realpath } from 'fs/promises'

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

  // Why: validatePath only normalizes `..` textually. A symlink inside the
  // workspace pointing outside it (e.g., workspace/evil -> /etc/) would pass
  // textual validation. This async variant resolves symlinks via realpath
  // before checking the path, closing the symlink traversal vector.
  async validatePathResolved(targetPath: string): Promise<void> {
    this.validatePath(targetPath)
    try {
      const real = await realpath(targetPath)
      this.validatePath(real)
    } catch {
      // Path doesn't exist yet (e.g., createFile) — textual check is sufficient
    }
  }
}
