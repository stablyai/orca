import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime/types'
import { rejectRemoteSelectionFlags } from '../remote-selection-flag-rejection'
import {
  configureChromeDevtools,
  isChromeDevtoolsTarget
} from '../../main/agent-mcp/chrome-devtools-setup'

const run =
  (setup: boolean): CommandHandler =>
  async ({ flags, json }) => {
    rejectRemoteSelectionFlags(
      flags,
      'Chrome DevTools setup; run this command directly on the agent execution host.'
    )
    if (
      flags.has('host') ||
      process.env.ORCA_CLI_CWD ||
      process.env.ORCA_ENVIRONMENT ||
      process.env.ORCA_PAIRING_CODE
    ) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Chrome DevTools setup requires a direct local invocation without remote routing flags or ORCA_CLI_CWD/ORCA_ENVIRONMENT/ORCA_PAIRING_CODE.'
      )
    }
    const agent = flags.get('agent')
    if (!isChromeDevtoolsTarget(agent)) {
      throw new RuntimeClientError(
        'invalid_argument',
        'Provide --agent codex, opencode, gemini, pi, or all.'
      )
    }
    const result = await configureChromeDevtools({ agent, apply: setup && !flags.has('dry-run') })
    printResult({ id: 'local', ok: true, result, _meta: { runtimeId: 'local' } }, json, (value) =>
      [
        `Execution host: ${value.executionHost} (${value.platform})`,
        ...value.configs.map(
          (config) =>
            `${config.agent}: ${config.state} — ${config.configPath}${config.backupPath ? `\nBackup: ${config.backupPath}` : ''}`
        ),
        'MCP handshake: not checked. Browser connection: not checked.',
        value.scope,
        value.nextStep
      ].join('\n')
    )
  }

export const AGENT_CHROME_DEVTOOLS_HANDLERS: Record<string, CommandHandler> = {
  'agent chrome-devtools setup': run(true),
  'agent chrome-devtools status': run(false)
}
