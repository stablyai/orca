import { createHash, randomBytes } from 'node:crypto'
import path from 'node:path'

export function resolveHostedWebViewRuntimeDirectory({
  worktree,
  override,
  runNonce = randomBytes(4).toString('hex')
}) {
  if (override) {
    return path.resolve(override)
  }
  const worktreeKey = createHash('sha256').update(worktree).digest('hex').slice(0, 8)
  // Why: keep daemon sockets below macOS's Unix-domain path limit.
  return path.join('/tmp', `orca-mw-${worktreeKey}-${runNonce}`)
}
