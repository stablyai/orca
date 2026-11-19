import type { openClaudeStreamJsonConnection } from '../../claude-stream-json-connection'
import { claudeConfigDirEnvPatch } from './claude-config-dir-pin'
import type { ClaudeStructuredLaunch } from './claude-structured-launch-resolution'

export function claudeConnectionSpawnRequest(
  launch: ClaudeStructuredLaunch
): Parameters<typeof openClaudeStreamJsonConnection>[0] {
  return {
    pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
    prefixArgs: launch.prefixArgs,
    options: launch.options,
    cwd: launch.cwd,
    env: {
      ...launch.env,
      // The saved account directory must override a conflicting environment overlay.
      ...claudeConfigDirEnvPatch(launch.claudeConfigDir, { env: launch.env })
    },
    ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {})
  }
}
