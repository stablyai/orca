import { existsSync } from 'node:fs'
import { claudeProfileMarkerPath, type ClaudeProfileDescriptor } from './claude-profile-paths'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'
import { claudeProfileSetupFailed } from './claude-profile-launch-errors'

/** First construction requires setup; a prepared profile keeps its existing bounded refresh behavior. */
export async function prepareClaudeProfileForLaunch(
  profile: ClaudeProfileDescriptor,
  setUp: (profile: ClaudeProfileDescriptor) => Promise<ClaudeProfileSetupReport>,
  waitMs = 5_000
): Promise<void> {
  if (!existsSync(claudeProfileMarkerPath(profile))) {
    const report = await setUp(profile).catch(() => null)
    if (report?.outcome !== 'prepared') {
      throw claudeProfileSetupFailed()
    }
    return
  }
  const refresh = setUp(profile).catch((error: unknown) => {
    console.warn('[claude-profile] Account refresh failed:', error)
  })
  await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, waitMs).unref())])
}
