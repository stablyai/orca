import { isAbsolute } from 'node:path'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import { hasExplicitTuiLaunchCommand } from '../../../../shared/agent-launch/startup/tui-agent-launch-command-override'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { CodexAutomationUpdateError } from '../../../agent-cli-update/codex-automation-update'

export function assertVerifiedCodexTerminalHost(
  program: string | undefined,
  agent: TuiAgent,
  runtime: AgentLaunchRuntime | Error,
  isRemote: boolean,
  settings: Parameters<typeof hasExplicitTuiLaunchCommand>[0]
): void {
  if (
    program &&
    (agent !== 'codex' ||
      isRemote ||
      runtime instanceof Error ||
      runtime.platform !== process.platform ||
      runtime.platform === 'win32' ||
      !isAbsolute(program) ||
      /\p{Cc}/u.test(program) ||
      hasExplicitTuiLaunchCommand(settings, 'codex'))
  ) {
    throw new CodexAutomationUpdateError(
      'The verified Codex installation is unavailable for this terminal launch.'
    )
  }
}
