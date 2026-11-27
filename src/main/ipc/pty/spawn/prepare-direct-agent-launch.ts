import { isAbsolute } from 'node:path'
import { withClaudeDirectLaunchCommand } from '../../../../shared/agent-launch/startup/claude-direct-launch-command'
import { withCodexScopedImageCommand } from '../../../../shared/agent-launch/startup/codex-scoped-image-command'
import { planCodexNoDaemonLaunch } from '../../../pty/shell-startup/codex-no-daemon-launch-command'
import {
  prepareShellNativeAgentLaunch,
  readCodexDirectLaunch,
  withCodexDirectLaunchCommand
} from '../../../../shared/agent-launch/startup/codex-startup-image-command'
import { readLaunchArguments } from '../../../../shared/agent-launch/startup/launch-position'
import {
  renderReceivingShellLaunch,
  type ReceivingShellCheck
} from '../../../../shared/agent-launch/startup/receiving-shell-agent-launch'
import type { AgentStartupShell } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { PtySpawnLaunchOptionsInput } from './spawn-options-assembly'

export async function prepareDirectLaunch(
  command: string,
  shell: AgentStartupShell,
  input: PtySpawnLaunchOptionsInput,
  env: NodeJS.ProcessEnv,
  local: boolean,
  images: boolean,
  authored: boolean,
  receivingShellCheck?: ReceivingShellCheck
): Promise<string> {
  const render = (prepared: string, fallback: string, codexProbeDone?: boolean) =>
    receivingShellCheck
      ? renderReceivingShellLaunch(receivingShellCheck, prepared, fallback, {
          codexProbeDone,
          prepareBareForSh: (bare) =>
            prepareShellNativeAgentLaunch(bare, shell, images, {
              allowByName: true,
              probeInShell: !local
            })
        })
      : fallback
  const invocation = readCodexDirectLaunch(command, shell)
  if (!invocation) {
    return render(command, authored ? command : withClaudeDirectLaunchCommand(command, shell))
  }
  const { launch } = invocation
  const absolute = isAbsolute(launch.executable)
  const probeInvocation =
    authored && local && absolute && shell === 'powershell' && !invocation.args
      ? {
          launch,
          args: readLaunchArguments(command, shell, launch, undefined, 'preserve-expansions')
        }
      : invocation
  const probe = planCodexNoDaemonLaunch(
    {
      command,
      executesOnThisHost: local && (!authored || shell === 'cmd' || absolute),
      env,
      envToDelete: input.envToDelete,
      cwd: input.cwd
    },
    shell,
    probeInvocation
  )
  const supported = await probe
  const prepared = supported
    ? `${command.slice(0, launch.end)} --no-daemon${command.slice(launch.end)}`
    : command
  if (authored) {
    return images ? withCodexScopedImageCommand(prepared, shell, launch) : prepared
  }
  const fallback = withCodexDirectLaunchCommand(
    prepared,
    shell,
    { images, probeInShell: !local },
    supported && invocation.args
      ? { ...invocation, args: ['--no-daemon', ...invocation.args] }
      : invocation
  )
  return render(prepared, fallback, probe !== null && !supported)
}
