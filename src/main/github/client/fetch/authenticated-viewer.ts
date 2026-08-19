import type { GitHubViewer } from '../../../../shared/github/pull-request-types'
import { execFileAsync, acquire, release } from '../../gh-utils'
/**
 * Get the authenticated GitHub viewer when gh is available and logged in.
 * Returns null when gh is unavailable, unauthenticated, or the lookup fails.
 */
export async function getAuthenticatedViewer(): Promise<GitHubViewer | null> {
  await acquire()
  try {
    const { stdout } = await execFileAsync(
      'gh',
      ['api', 'user', '--jq', '{login: .login, email: .email}'],
      { encoding: 'utf-8' }
    )
    const viewer = JSON.parse(stdout) as { login?: string; email?: string | null }
    if (!viewer.login?.trim()) {
      return null
    }
    return {
      login: viewer.login.trim(),
      email: viewer.email?.trim() || null
    }
  } catch {
    return null
  } finally {
    release()
  }
}
