import path from 'node:path'
import { planAgentBinary } from '../../shared/commit-message-plan'
import { resolveCliCommand } from '../../shared/node-cli-command-resolution'

export function resolveAntigravityUsageCommand(
  override?: string,
  platform: NodeJS.Platform = process.platform
): { ok: true; command: string } | { ok: false; error: string } {
  const plan = planAgentBinary('agy', override, platform === 'win32' ? 'literal' : 'escape')
  if (!plan.ok || plan.prefixArgs.length > 0) {
    return {
      ok: false,
      error:
        'Antigravity usage requires a command containing only the executable path. The configured launch command cannot be used for quota refresh.'
    }
  }
  const hostPath = platform === 'win32' ? path.win32 : path.posix
  const command = hostPath.isAbsolute(plan.binary)
    ? plan.binary
    : resolveCliCommand(plan.binary, { platform })
  return hostPath.isAbsolute(command)
    ? { ok: true, command }
    : {
        ok: false,
        error: 'Antigravity usage is unavailable because the configured CLI was not found.'
      }
}
