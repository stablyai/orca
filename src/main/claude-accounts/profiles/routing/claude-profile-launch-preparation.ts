import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  claudeProfileLaunchPointerPath,
  claudeProfileMarkerPath,
  type ClaudeProfileDescriptor
} from '../claude-profile-paths'
import type { ClaudeProfileSetupReport } from '../setup/claude-profile-setup'
import { claudeProfileSetupFailed } from './claude-profile-launch-errors'
import { isDirectory } from '../claude-profile-homes'

/** First construction requires setup; a prepared profile keeps its existing bounded refresh behavior. */
export async function prepareClaudeProfileForLaunch(
  profile: ClaudeProfileDescriptor,
  setUp: (profile: ClaudeProfileDescriptor) => Promise<ClaudeProfileSetupReport>,
  waitMs = 5_000
): Promise<void> {
  if (!isDirectory(profile.home) || !existsSync(claudeProfileMarkerPath(profile))) {
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

async function publishClaudeLaunchPointer(pointerPath: string, home: string): Promise<void> {
  if ((await readFile(pointerPath, 'utf8').catch(() => null)) === home) {
    return
  }
  await mkdir(dirname(pointerPath), { recursive: true, mode: 0o700 })
  // Shells re-read the pointer at any time, so it is replaced, never half-written.
  const staged = `${pointerPath}.${process.pid}.tmp`
  await writeFile(staged, home, { mode: 0o600 })
  await rename(staged, pointerPath)
}

// Its own pointer keeps a pane's `claude` on this account: the shell function re-reads it.
export async function writeClaudeLaunchPointer(
  dataRoot: string,
  profile: ClaudeProfileDescriptor
): Promise<string> {
  const pointerPath = claudeProfileLaunchPointerPath(dataRoot, profile.accountId)
  await publishClaudeLaunchPointer(pointerPath, profile.home)
  return pointerPath
}

// Panes launched on a removed account follow the selection instead of System default.
export async function repointClaudeLaunchPointer(
  dataRoot: string,
  accountId: string,
  routedHome: string | null
): Promise<void> {
  const pointerPath = claudeProfileLaunchPointerPath(dataRoot, accountId)
  if ((await readFile(pointerPath, 'utf8').catch(() => null)) !== null) {
    await publishClaudeLaunchPointer(pointerPath, routedHome ?? '')
  }
}
