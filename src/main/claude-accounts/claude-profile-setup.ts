import type { AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { shareClaudeProfileHistory } from './claude-profile-history'
import { prepareClaudeProfileDirectory, type ClaudeProfileDescriptor } from './claude-profile-paths'
import { provisionClaudeProfile } from './claude-profile-provisioning'
import {
  ClaudeProfileSurfaceError,
  createClaudeProfileReport,
  runClaudeProfileSurface,
  warnClaudeProfile,
  type ClaudeProfileReport
} from './claude-profile-report'

/** `refused`: the profile failed its ownership gate and no surface was touched. */
export type ClaudeProfileSetupReport = ClaudeProfileReport & { outcome: 'refused' | 'prepared' }

/**
 * The one entry for setting up a managed Claude profile. Runs on the execution host that owns the
 * profile; for WSL that is inside the guest, never across a UNC path.
 */
export async function provisionClaudeAccountProfile(args: {
  dataRoot: string
  profile: ClaudeProfileDescriptor
  userHome: string
  /** The user's own CLAUDE_CONFIG_DIR (see readUserClaudeConfigDir); `~/.claude` when unset. */
  userConfigDir?: string
  /** Null when Orca's Claude hooks are turned off. Runs after the settings copy so its entries survive it. */
  installHooks: ((target: { configDir: string }) => AgentHookInstallStatus) | null
  platform?: NodeJS.Platform
}): Promise<ClaudeProfileSetupReport> {
  const platform = args.platform ?? process.platform
  const report = createClaudeProfileReport()
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
    () => provisionClaudeProfile({ ...shared, platform })
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
  // Last: a setup cut off before here leaves no marker, so the next launch waits for a full one.
  markSetUp()
  return { outcome: 'prepared', ...report }
}
