import { spawnProcess } from '@orca/process-host'
import { FD_CLOSING_EXEC_ARGS } from '../../daemon/launch/daemon-fd-closing-exec'
import { resolveProviderExecPath } from '../../provider-process/provider-process-supervisor'
import type {
  SourceControlAgentSpawnInput,
  SpawnedSourceControlAgentProcess
} from '../source-control-text-generation-types'

/** Unsupervised, since a one-shot's supervisor stops the daemon this command leaves running. */
export function spawnDaemonStarterAgent(
  launch: { binary: string; args: readonly string[]; cwd?: string; env: NodeJS.ProcessEnv },
  stdinMode: SourceControlAgentSpawnInput['stdinMode']
): SpawnedSourceControlAgentProcess {
  // Linux: like Orca's own daemon, it must not keep main's Chromium IPC sockets open.
  const fdClosingExec = process.platform === 'linux' ? resolveProviderExecPath('linux') : undefined
  return spawnProcess({
    program: fdClosingExec ?? launch.binary,
    args: fdClosingExec ? [...FD_CLOSING_EXEC_ARGS, launch.binary, ...launch.args] : launch.args,
    env: launch.env,
    ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
    // Its own session, as the supervisor gave it, so signals to Orca's group miss the daemon.
    detached: true,
    stdio: [stdinMode, 'pipe', 'pipe']
  })
}
