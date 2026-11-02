import type { PreparedAgentSpawn } from '../../../daemon/prepared-agent-launch-protocol'
import type { PtyRuntimeControllerDeps } from './controller-deps'
import { createRuntimePtySpawnState, type RuntimePtySpawnArgs } from './spawn-state'
import { prepareRuntimePtySpawn } from './spawn-preflight'
import { buildRuntimePtySpawnOptions } from './spawn-options'

/** The ordinary host preparation, without publishing a pane or dispatching a process. */
export async function prepareRuntimeTerminalLaunch(
  deps: PtyRuntimeControllerDeps,
  args: RuntimePtySpawnArgs
): Promise<PreparedAgentSpawn> {
  if (args.connectionId) {
    throw new Error('prepared_agent_launch_unsupported')
  }
  const ctx = createRuntimePtySpawnState(deps, { ...args })
  try {
    await prepareRuntimePtySpawn(ctx)
    await buildRuntimePtySpawnOptions(ctx)
    if (
      !ctx.sessionId ||
      !ctx.provider.preparedAgentLaunch ||
      !(await ctx.provider.supportsPreparedAgentLaunches?.())
    ) {
      throw new Error('prepared_agent_launch_unsupported')
    }
    if (!ctx.provider.prepareAgentLaunchSpawn) {
      throw new Error('prepared_agent_launch_unsupported')
    }
    return await ctx.provider.prepareAgentLaunchSpawn(ctx.spawnOptions)
  } finally {
    ctx.finishTerminalInstall()
  }
}
