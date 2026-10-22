import { resolveLoginShellEnvironment } from '../startup/login-shell-environment'
import { readUserClaudeConfigDir, resolveClaudeDefaultHome } from '../../shared/claude-user-config'
import { resolveClaudeCommand } from '../../shared/node-cli-command-resolution'
import { probeClaudeCliVersion } from '../claude/claude-hook-event-versions'
import { ClaudeHookService } from '../claude/hook-service'
import {
  provisionClaudeAccountProfile,
  type ClaudeProfileSetupReport
} from './claude-profile-setup'
import { wslClaudeProfile } from './claude-profile-wsl-paths'

/** Runs on the guest so the copied settings and hook installer share System default. */
export async function provisionWslClaudeAccountProfile(
  userHome: string,
  distro: string,
  accountId: string,
  hooks = false
): Promise<ClaudeProfileSetupReport> {
  const { dataRoot, profile } = wslClaudeProfile(userHome, distro, accountId)
  const env = await resolveLoginShellEnvironment()
  const userConfigDir = readUserClaudeConfigDir(env)
  const claudeVersion = hooks
    ? await probeClaudeCliVersion(resolveClaudeCommand({ pathEnv: env.PATH, homePath: userHome }), {
        cwd: userHome,
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
        )
      })
    : null
  return provisionClaudeAccountProfile({
    dataRoot,
    profile,
    userHome,
    userConfigDir,
    installHooks: hooks
      ? ({ configDir }) =>
          new ClaudeHookService().install({
            target: {
              kind: 'profile',
              configDir,
              systemDefaultConfigDir: resolveClaudeDefaultHome(userHome, userConfigDir)
            },
            claudeVersion: claudeVersion ?? undefined
          })
      : null
  })
}
