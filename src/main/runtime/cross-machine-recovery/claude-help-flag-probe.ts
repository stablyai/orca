import { planAgentCommand } from '../../../shared/agent-command-plan'
import { runProcess } from '../../../shared/child-process/run-process'
import { mergeCommandEnvironment } from '../../../shared/command-environment'
import type { TuiAgent } from '../../../shared/tui-agent'
import { resolveAgentBaseLaunchCommand } from '../../../shared/tui-agent-launch-command'
import { commandBackslashMode } from '../../text-generation/commit-message-text-generation'

const CLAUDE_HELP_TIMEOUT_MS = 10_000

/**
 * Resolves whether `--help` of the claude command a local launch would run advertises `flag`,
 * once per resolved command so a changed override re-probes; a missing CLI reads as unadvertised.
 */
export function createClaudeHelpFlagProbe(
  flag: string,
  readCmdOverrides: () => Partial<Record<TuiAgent, string>>,
  run: typeof runProcess = runProcess
): () => Promise<boolean> {
  const advertisedByCommand = new Map<string, Promise<boolean>>()
  return () => {
    const command = resolveAgentBaseLaunchCommand({
      agent: 'claude',
      cmdOverrides: readCmdOverrides(),
      platform: process.platform
    })
    let advertised = advertisedByCommand.get(command)
    if (!advertised) {
      advertised = helpAdvertises(command, flag, run)
      advertisedByCommand.set(command, advertised)
    }
    return advertised
  }
}

async function helpAdvertises(
  command: string,
  flag: string,
  run: typeof runProcess
): Promise<boolean> {
  const plan = planAgentCommand(command, commandBackslashMode({ kind: 'local', cwd: '' }))
  if (!plan.ok) {
    return false
  }
  const result = await run({
    program: plan.binary,
    args: [...plan.prefixArgs, '--help'],
    env: mergeCommandEnvironment(undefined, plan.env, process.platform),
    timeoutMs: CLAUDE_HELP_TIMEOUT_MS
  }).catch(() => null)
  return result?.code === 0 && result.stdout.includes(flag)
}
