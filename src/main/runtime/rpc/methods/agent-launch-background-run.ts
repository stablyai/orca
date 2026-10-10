/**
 * A desktop automation's run through `agent.launch` (`backgroundRun`): the launch that window would
 * build, spawned through that window's own spawn, so the agent gets main's command, environment and
 * terminal and the window adopts the hidden run tab as it always has. It runs through the shared
 * executor, terminal-only, with no launch record: bookkeeping can never stop it, and the run id
 * stays the automation's idempotency. Temporary until one planner builds every launch
 * (launch-unification phase 2).
 *
 * Anything that fails before the spawn is requested answers `unavailable`, and the window then starts
 * the run itself, as on main. After that request a failure fails the run, and a PTY the spawn already
 * answered is stopped, as the window stops its own.
 */

import type {
  AgentLaunchBackgroundRunSpawn,
  AgentLaunchResult
} from '../../../../shared/agent-launch-intent'
import {
  AGENT_LAUNCH_BACKGROUND_RUN_SPAWN_FAILED_CODE,
  AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE
} from '../../../../shared/agent-launch-background-run'
import {
  backgroundRunPaneEnv,
  buildBackgroundRunPtySpawn,
  buildBackgroundRunStartup
} from '../../../../shared/background-run-launch'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import { getWindowPtySpawn } from '../../../ipc/pty/ipc/window-pty-spawn'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'

type BackgroundRun = NonNullable<AgentLaunchParams['backgroundRun']>

/** How far this run's spawn got, which decides what a failure owes. */
type SpawnProgress = {
  requested: boolean
  /** The PTY the spawn answered, and the window's own stop for it. */
  spawned?: { answer: AgentLaunchBackgroundRunSpawn; stop: () => Promise<void> }
}

export async function runBackgroundRunAgentLaunch(
  params: AgentLaunchParams,
  context: RpcContext
): Promise<AgentLaunchResult> {
  const { backgroundRun } = params
  const progress: SpawnProgress = { requested: false }
  try {
    if (
      !backgroundRun ||
      context.caller?.kind !== 'desktop' ||
      params.operationId ||
      params.target.kind !== 'existing'
    ) {
      throw unavailable()
    }
    const intent = await resolveUnlaunchedIntent(params, context.runtime, null)
    const { target } = intent
    // The window keeps SSH launches: their relay delivery is not this host's to rebuild yet.
    if (target.kind !== 'existing' || target.workspacePath === undefined || target.connectionId) {
      throw unavailable()
    }
    const workspacePath = target.workspacePath
    const result = await executeAgentLaunch({
      runtime: context.runtime,
      intent,
      // The run is observed through its terminal, whatever the chat default says.
      terminalOnly: true,
      surfaces: {
        createStructuredSession: () => {
          throw unavailable()
        },
        createTerminalAgent: ({ worktreeId, startupPrompt, launchSource, paneKey }) =>
          spawnWindowLaunch({
            runtime: context.runtime,
            workspacePath,
            worktreeId,
            agent: intent.agent,
            startupPrompt,
            launchSource,
            paneKey,
            backgroundRun,
            progress
          })
      }
    })
    if (!progress.spawned) {
      throw new Error('The agent launch did not report its terminal.')
    }
    return { ...result, backgroundRun: progress.spawned.answer }
  } catch (error) {
    if (!progress.requested) {
      throw new Error(AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE, { cause: error })
    }
    try {
      // The window never learns this PTY, so nothing else would stop it.
      await progress.spawned?.stop()
    } catch {
      // Best effort: the run records the launch's own failure.
    }
    throw error
  }
}

/** Builds the launch exactly as the window's `launch-agent-background-session` builds it for a local
 *  workspace, and spawns it through that window's spawn. */
async function spawnWindowLaunch(args: {
  runtime: Pick<OrcaRuntimeService, 'preAllocateHandleForPty'>
  workspacePath: string
  worktreeId: string
  agent: TuiAgent
  /** An argv agent's prompt, which rides the command at any length, as the window's did. */
  startupPrompt: string | undefined
  launchSource: string | undefined
  paneKey: string | undefined
  backgroundRun: BackgroundRun
  progress: SpawnProgress
}): Promise<{ handle: string; paneKey: string; promptRodeLaunchCommand?: true }> {
  const { runtime, worktreeId, agent, paneKey, backgroundRun, progress } = args
  const windowSpawn = getWindowPtySpawn()
  const pane = paneKey ? parsePaneKey(paneKey) : null
  if (!windowSpawn || !paneKey || !pane) {
    throw unavailable()
  }
  const startup = buildBackgroundRunStartup({
    agent,
    settings: windowSpawn.getSettings(),
    platform: process.platform,
    isRemote: false,
    extraAgentArgs: backgroundRun.extraAgentArgs,
    prompt: args.startupPrompt
  })
  if (!startup) {
    throw unavailable()
  }
  const { launchToken } = backgroundRun
  const spawnArgs = buildBackgroundRunPtySpawn({
    agent,
    plan: startup.plan,
    cwd: args.workspacePath,
    worktreeId,
    sshConnectionId: null,
    env: backgroundRunPaneEnv({
      env: startup.plan.env,
      paneKey,
      tabId: pane.tabId,
      worktreeId,
      launchToken
    }),
    launchToken,
    tabId: pane.tabId,
    leafId: pane.leafId,
    ...(backgroundRun.title ? { title: backgroundRun.title } : {}),
    ...(args.launchSource ? { launchSource: args.launchSource } : {})
  })
  progress.requested = true
  let spawned: Awaited<ReturnType<typeof windowSpawn.spawn>>
  try {
    spawned = await windowSpawn.spawn(spawnArgs)
  } catch (error) {
    // Electron logged a failed `pty:spawn` this way before replying to the window.
    console.error("Error occurred in handler for 'pty:spawn':", error)
    // The window records this as its own spawn's failure, in the words main recorded.
    throw Object.assign(new Error(String(error)), {
      code: AGENT_LAUNCH_BACKGROUND_RUN_SPAWN_FAILED_CODE
    })
  }
  // A fresh pane is never a reattach; one that answered no PTY has nothing to adopt.
  if (!('id' in spawned)) {
    throw new Error('The agent launch did not report its terminal.')
  }
  const ptyId = spawned.id
  progress.spawned = {
    answer: {
      ptyId,
      ...(spawned.incarnationId ? { incarnationId: spawned.incarnationId } : {}),
      ...(spawned.launchConfig ? { launchConfig: spawned.launchConfig } : {})
    },
    stop: () => windowSpawn.stop(ptyId)
  }
  return {
    handle: runtime.preAllocateHandleForPty(ptyId),
    paneKey,
    ...(startup.commandPrompt ? { promptRodeLaunchCommand: true as const } : {})
  }
}

function unavailable(): Error {
  return new Error(AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE)
}
