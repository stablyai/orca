import { existsSync } from 'node:fs'
import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { shareClaudeProfileHistory } from './claude-profile-history'
import {
  claudeProfileMarkerPath,
  prepareClaudeProfileDirectory,
  type ClaudeProfileDescriptor
} from './claude-profile-paths'
import { provisionClaudeProfile } from './claude-profile-provisioning'
import {
  ClaudeProfileSurfaceError,
  createClaudeProfileReport,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport
} from './claude-profile-report'

/** `refused` means ownership validation failed before any writes. */
export type ClaudeProfileSetupReport = ClaudeProfileReport & { outcome: 'refused' | 'prepared' }

/** Run on the execution host; WSL profiles must be set up inside the guest. */
export async function provisionClaudeAccountProfile(args: {
  dataRoot: string
  profile: ClaudeProfileDescriptor
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR; defaults to `~/.claude`. */
  userConfigDir?: string
  /** Runs after settings are copied so hook entries survive; null disables installation. */
  installHooks: ((target: { configDir: string }) => AgentHookInstallStatus) | null
  platform?: NodeJS.Platform
}): Promise<ClaudeProfileSetupReport> {
  const platform = args.platform ?? process.platform
  const report = createClaudeProfileReport()
  const firstSetup = !existsSync(claudeProfileMarkerPath(args.profile))
  let markSetUp: () => void
  try {
    if (args.profile.target.runtime === 'wsl' && platform === 'win32') {
      throw new ClaudeProfileSurfaceError('invalid-profile', 'WSL profiles are set up in the guest')
    }
    markSetUp = prepareClaudeProfileDirectory(
      args.dataRoot,
      args.profile,
      args.userHome,
      args.userConfigDir
    )
  } catch (error) {
    report.surfaces.profile = 'failed'
    warnClaudeProfile(report, 'profile', error)
    return { outcome: 'refused', ...report }
  }
  const home = args.profile.home
  const shared = { profileHome: home, userHome: args.userHome, userConfigDir: args.userConfigDir }
  for (const step of [
    () => shareClaudeProfileHistory({ ...shared, platform }),
    () => provisionClaudeProfile({ ...shared, platform, firstSetup })
  ]) {
    try {
      const part = await step()
      Object.assign(report.surfaces, part.surfaces)
      report.warnings.push(...part.warnings)
    } catch (error) {
      warnClaudeProfile(report, 'profile', error)
    }
  }
  const installHooks = args.installHooks
  await runClaudeProfileSurface(report, 'hooks', () => {
    if (!installHooks) {
      return 'absent'
    }
    const status = installHooks({ configDir: home })
    if (status.state !== 'installed') {
      throw new Error(status.detail ?? `Claude hooks ${status.state}`)
    }
    return 'merged'
  })
  // Mark last so interrupted setup is retried before the next launch.
  markSetUp()
  return { outcome: 'prepared', ...report }
}
