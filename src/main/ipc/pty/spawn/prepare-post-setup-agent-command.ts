import { readLaunchPosition } from '../../../../shared/agent-launch/startup/launch-position'
import { matchesStockLaunchProgram } from '../../../../shared/agent-launch/startup/managed-agent-launch-program'
import {
  readCodexDirectLaunch,
  withCodexDirectLaunchCommand
} from '../../../../shared/agent-launch/startup/codex-startup-image-command'
import { withClaudeDirectLaunchCommand } from '../../../../shared/agent-launch/startup/claude-direct-launch-command'
import { prepareFreshOmpLaunch } from '../../../../shared/agent-launch/startup/omp-fresh-launch'
import {
  setupAgentProgramExpression,
  setupAgentProgramPathExpression,
  type SetupAgentProgram
} from '../../../../shared/agent-launch/startup/setup-agent-program'

export async function preparePostSetupCommand(
  command: string,
  program: SetupAgentProgram,
  shell: 'posix' | 'powershell',
  images: boolean
): Promise<string | undefined> {
  const programExpression = setupAgentProgramPathExpression(shell)
  const render = (inner: string): string => {
    const launch = readLaunchPosition(inner, shell)
    if (
      !launch ||
      !matchesStockLaunchProgram(launch.executable, program.launchHead, process.platform)
    ) {
      return inner
    }
    const codex = withCodexDirectLaunchCommand(
      inner,
      shell,
      { images, probeInShell: true, programExpression },
      readCodexDirectLaunch(inner, shell, true)
    )
    const wrapped =
      codex === inner ? withClaudeDirectLaunchCommand(inner, shell, programExpression) : codex
    if (wrapped !== inner) {
      return wrapped
    }
    return shell === 'powershell'
      ? `${inner.slice(0, launch.invocationStart)}& ${programExpression}${inner.slice(launch.end)}`
      : inner.slice(0, launch.start) + setupAgentProgramExpression(shell) + inner.slice(launch.end)
  }
  const direct = render(command)
  const prepared =
    direct === command
      ? await prepareFreshOmpLaunch(command, shell, async (inner) => render(inner))
      : direct
  return prepared === command ? undefined : prepared
}
