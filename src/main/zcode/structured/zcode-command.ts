/** Resolves the `zcode` program a chat runs, honouring the user's per-agent Command override. */

import {
  resolveStructuredAgentCommand,
  type StructuredAgentCommand,
  type StructuredAgentCommandSettings
} from '../../native-chat/agent-launch/structured-agent-command-resolution'
import type { resolveCliCommand } from '../../../shared/shell/command-resolution/node-cli-command-resolution'

export function resolveZcodeCommand(
  env: Readonly<Record<string, string>>,
  commandSettings: StructuredAgentCommandSettings = {},
  resolve?: typeof resolveCliCommand
): StructuredAgentCommand {
  const homePath = env.HOME ?? env.USERPROFILE
  return resolveStructuredAgentCommand(
    'zcode',
    commandSettings,
    { pathEnv: env.PATH ?? env.Path ?? null, ...(homePath ? { homePath } : {}) },
    resolve ? { resolve } : {}
  )
}
