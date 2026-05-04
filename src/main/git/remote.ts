import { gitExecFileAsync } from './runner'

// Why: git's stderr often embeds the full remote URL, which can include an
// embedded credential — either `https://user:token@host/...` (the classic
// user+pass form) OR `https://token@host/...` (token-only, which GitHub's
// "fine-grained PAT" docs explicitly recommend). Both must be redacted. We
// match an optional `user:` segment followed by a secret then `@`.
const CREDENTIAL_URL_PATTERN = /(https?:\/\/)([^\s/@]+:)?[^\s/@]+@/g

function stripCredentialsFromMessage(message: string): string {
  return message.replace(CREDENTIAL_URL_PATTERN, '$1')
}

function extractTailLine(message: string): string {
  // Why: execFile rejections prefix the message with "Command failed: git ..."
  // followed by the full stderr. The meaningful diagnostic is typically the
  // last non-empty line; surfacing the full blob risks leaking local paths or
  // environment details to the UI.
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  return lines.at(-1) ?? message
}

export function normalizeGitErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'Git remote operation failed.'
  }

  const raw = error.message

  if (raw.includes('non-fast-forward') || raw.includes('fetch first')) {
    // Why: this specific guidance tells users the safe recovery path instead
    // of surfacing raw git stderr that varies across git versions/locales.
    return 'Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.'
  }

  if (raw.includes('could not read Username') || raw.includes('Authentication failed')) {
    return 'Authentication failed. Check your remote credentials.'
  }

  if (raw.includes('Could not resolve host') || raw.includes('Network is unreachable')) {
    return 'Network error. Check your connection.'
  }

  if (raw.includes('no tracking information') || raw.includes('no upstream')) {
    return 'Branch has no upstream. Publish the branch first.'
  }

  // Fallthrough: extract only the tail stderr line and scrub any embedded
  // credential before returning. See CREDENTIAL_URL_PATTERN comment above.
  return stripCredentialsFromMessage(extractTailLine(raw))
}

export async function gitPush(worktreePath: string, publish = false): Promise<void> {
  try {
    const args = publish ? ['push', '--set-upstream', 'origin', 'HEAD'] : ['push']
    await gitExecFileAsync(args, { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error))
  }
}

export async function gitPull(worktreePath: string): Promise<void> {
  // Why: plain `git pull` uses the user's configured pull strategy (merge by
  // default) so diverged branches reconcile instead of erroring out. Conflicts
  // surface through the existing conflict-resolution flow.
  try {
    await gitExecFileAsync(['pull'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error))
  }
}

export async function gitFetch(worktreePath: string): Promise<void> {
  try {
    await gitExecFileAsync(['fetch', '--prune'], { cwd: worktreePath })
  } catch (error) {
    throw new Error(normalizeGitErrorMessage(error))
  }
}
