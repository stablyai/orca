/**
 * A desktop automation's run through `agent.launch` (`backgroundRun`): the launch that window would
 * build, spawned through that window's own spawn, so the agent gets main's command, environment and
 * terminal and the window adopts the hidden run tab as it always has. It runs through the shared
 * executor, terminal-only, with no launch record: bookkeeping can never stop it, and the run id
 * stays the automation's idempotency. Temporary until one planner builds every launch
 * (launch-unification phase 2).
 *
 * Anything that fails before the spawn is requested answers `unavailable`, and the window then starts
 * the run itself, as on main. After that request a failure may have left an agent, so it is the run's.
 */

import type {
  AgentLaunchBackgroundRunSpawn,
  AgentLaunchResult
} from '../../../../shared/agent-launch-intent'
import {
  AGENT_LAUNCH_BACKGROUND_RUN_SPAWN_FAILED_CODE,
  AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE
} from '../../../../shared/agent-launch-background-run'
import { tuiAgentToAgentKind } from '../../../../shared/agent-kind'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-startup-plan-inputs'
import type { AgentLaunchParams } from '../../../../shared/rpc-contract/agent-launch-params'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildAgentStartupPlan } from '../../../../shared/tui-agent-startup'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import { executeAgentLaunch } from '../../../agent-launch/agent-launch-executor'
import { getWindowPtySpawn } from '../../../ipc/pty/ipc/window-pty-spawn'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { resolveUnlaunchedIntent } from './agent-launch-intent-resolution'

type BackgroundRun = NonNullable<AgentLaunchParams['backgroundRun']>

export async function runBackgroundRunAgentLaunch(
  params: AgentLaunchParams,
  context: RpcContext
): Promise<AgentLaunchResult> {
  const { backgroundRun } = params
  let spawnRequested = false
  let spawned: AgentLaunchBackgroundRunSpawn | undefined
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
    const result = await executeAgentLaunch({
      runtime: context.runtime,
      intent,
      // The run is observed through its terminal, whatever the chat default says.
      terminalOnly: true,
      surfaces: {
        createStructuredSession: () => {
          throw unavailable()
        },
        createTerminalAgent: async ({ worktreeId, startupPrompt, launchSource, paneKey }) => {
          const terminal = await spawnWindowLaunch({
            runtime: context.runtime,
            worktreeId,
            agent: intent.agent,
            startupPrompt,
            launchSource,
            paneKey,
            backgroundRun,
            onSpawnRequested: () => {
              spawnRequested = true
            }
          })
          spawned = terminal.spawned
          return terminal.surface
        }
      }
    })
    if (!spawned) {
      throw new Error('The agent launch did not report its terminal.')
    }
    return { ...result, backgroundRun: spawned }
  } catch (error) {
    if (!spawnRequested) {
      throw new Error(AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE, { cause: error })
    }
    throw error
  }
}

/** Builds the launch exactly as the window's `launch-agent-background-session` builds it for a local
 *  workspace, and spawns it through that window's spawn. */
async function spawnWindowLaunch(args: {
  runtime: Pick<OrcaRuntimeService, 'showTerminalWorkspaceLaunchScope' | 'preAllocateHandleForPty'>
  worktreeId: string
  agent: TuiAgent
  /** An argv agent's prompt, which rides the command at any length, as the window's did. */
  startupPrompt: string | undefined
  launchSource: string | undefined
  paneKey: string | undefined
  backgroundRun: BackgroundRun
  onSpawnRequested: () => void
}): Promise<{
  surface: { handle: string; paneKey: string; promptRodeLaunchCommand?: true }
  spawned: AgentLaunchBackgroundRunSpawn
}> {
  const { runtime, worktreeId, agent, startupPrompt, paneKey, backgroundRun } = args
  const windowSpawn = getWindowPtySpawn()
  const pane = paneKey ? parsePaneKey(paneKey) : null
  if (!windowSpawn || !paneKey || !pane) {
    throw unavailable()
  }
  const workspace = await runtime.showTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
  // The window keeps SSH launches: their relay delivery is not this host's to rebuild yet.
  if (workspace.connectionId) {
    throw unavailable()
  }
  const plan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent,
      settings: windowSpawn.getSettings(),
      platform: process.platform,
      isRemote: false,
      ...(backgroundRun.extraAgentArgs ? { extraAgentArgs: backgroundRun.extraAgentArgs } : {})
    }),
    prompt: startupPrompt ?? '',
    allowEmptyPromptLaunch: !startupPrompt
  })
  if (!plan) {
    throw unavailable()
  }
  const { title, launchToken } = backgroundRun
  args.onSpawnRequested()
  let spawned: Awaited<ReturnType<typeof windowSpawn.spawn>>
  try {
    spawned = await windowSpawn.spawn({
      cols: 120,
      rows: 40,
      cwd: workspace.path,
      command: plan.launchCommand,
      ...(isWslUncPath(workspace.path) ? { shellOverride: 'wsl.exe' } : {}),
      ...(plan.startupCommandDelivery
        ? { startupCommandDelivery: plan.startupCommandDelivery }
        : {}),
      env: {
        ...plan.env,
        ORCA_PANE_KEY: paneKey,
        ORCA_TAB_ID: pane.tabId,
        ORCA_WORKTREE_ID: worktreeId,
        ORCA_AGENT_LAUNCH_TOKEN: launchToken
      },
      launchConfig: plan.launchConfig,
      launchToken,
      launchAgent: agent,
      connectionId: null,
      worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId,
      placement: { kind: 'new-tab', ...(title ? { row: { customTitle: title } } : {}) },
      telemetry: {
        agent_kind: tuiAgentToAgentKind(agent),
        launch_source: args.launchSource ?? 'unknown',
        request_kind: 'new'
      }
    })
  } catch (error) {
    // The window records this as its own spawn's failure, in the words main recorded.
    throw Object.assign(new Error(String(error)), {
      code: AGENT_LAUNCH_BACKGROUND_RUN_SPAWN_FAILED_CODE
    })
  }
  // A fresh pane is never a reattach; one that answered no PTY has nothing to adopt.
  if (!('id' in spawned)) {
    throw new Error('The agent launch did not report its terminal.')
  }
  return {
    surface: {
      handle: runtime.preAllocateHandleForPty(spawned.id),
      paneKey,
      ...(startupPrompt ? { promptRodeLaunchCommand: true as const } : {})
    },
    spawned: {
      ptyId: spawned.id,
      ...(spawned.incarnationId ? { incarnationId: spawned.incarnationId } : {}),
      ...(spawned.launchConfig ? { launchConfig: spawned.launchConfig } : {})
    }
  }
}

function unavailable(): Error {
  return new Error(AGENT_LAUNCH_BACKGROUND_RUN_UNAVAILABLE_CODE)
}
