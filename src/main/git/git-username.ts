import type { SshGitProvider } from '../providers/ssh-git-provider'

const EXPLICIT_USERNAME_CONFIG_KEYS = ['github.user', 'user.username'] as const

export function normalizeGitUsername(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) {
    return ''
  }

  const localPart = trimmed.includes('@') ? trimmed.split('@')[0] : trimmed
  return localPart.replace(/^\d+\+/, '')
}

export async function getSshGitUsername(
  provider: SshGitProvider,
  repoPath: string
): Promise<string> {
  // Why: SSH targets cannot rely on the local `gh` account, and git email/name
  // are author identity rather than hosted-account usernames.
  for (const key of EXPLICIT_USERNAME_CONFIG_KEYS) {
    try {
      const { stdout } = await provider.exec(['config', '--get', key], repoPath)
      const username = normalizeGitUsername(stdout)
      if (username) {
        return username
      }
    } catch {
      // Missing config keys are expected; try the next explicit username key.
    }
  }
  return ''
}
