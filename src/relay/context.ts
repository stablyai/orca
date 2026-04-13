import { resolve, relative, isAbsolute } from 'path'
import { realpathSync } from 'fs'
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
    const resolved = resolve(rootPath)
    this.authorizedRoots.add(resolved)
    // Why: on macOS, /tmp is a symlink to /private/tmp. If a root is registered
    // as /tmp/workspace, validatePathResolved would resolve it to /private/tmp/
    // workspace, which fails the textual root check. Register both forms so the
    // resolved path also passes validation.
    try {
      const real = realpathSync(resolved)
      if (real !== resolved) {
        this.authorizedRoots.add(real)
      }
    } catch {
      // Root doesn't exist yet — textual form is sufficient
    }
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
    } catch (err) {
      // Why: ENOENT/ENOTDIR means the path doesn't exist yet (e.g., createFile)
      // so the textual check above is sufficient. Other errors (EACCES, EIO)
      // indicate real problems that should propagate.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw err
      }
    }
  }
}
