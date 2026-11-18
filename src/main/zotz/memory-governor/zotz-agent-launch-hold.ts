import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../../../shared/agent-launch/catalog/tui-agent-config'
import type { ZotzAgentTaskPriority } from '../../../shared/zotz/agent-queue/zotz-agent-queue'
import { resolveEarlyPaneKey } from '../../ipc/pty/spawn-pane-coordinates'
import type { ZotzAgentLaunchQueue } from './zotz-agent-launch-queue'

let launchQueue: ZotzAgentLaunchQueue | null = null

export function setZotzAgentLaunchQueue(queue: ZotzAgentLaunchQueue | null): void {
  launchQueue = queue
}

export function getZotzAgentLaunchQueue(): ZotzAgentLaunchQueue | null {
  return launchQueue
}

/** The spawn arguments the hold reads; renderer and runtime spawns both carry these. */
type HoldableSpawnArgs = {
  launchAgent?: unknown
  agentLaunch?: unknown
  command?: unknown
  telemetry?: { agent_kind?: unknown; launch_source?: unknown }
  spawnIntent?: unknown
  sessionId?: string
  worktreeId?: string
  tabId?: string
  leafId?: string
  signal?: AbortSignal
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Renderer launches through the host carry the agent only inside the not-yet-planned agentLaunch.
function launchedAgent(args: HoldableSpawnArgs): TuiAgent | null {
  if (isTuiAgent(args.launchAgent)) {
    return args.launchAgent
  }
  if (isTuiAgent(args.telemetry?.agent_kind)) {
    return args.telemetry.agent_kind
  }
  const launch = isRecord(args.agentLaunch) ? args.agentLaunch.launch : undefined
  return isRecord(launch) && isTuiAgent(launch.agent) ? launch.agent : null
}

/** UI spawns are the user at the keyboard; runtime ones come from paired clients, the CLI or automations. */
function launchPriority(args: HoldableSpawnArgs, origin: 'ui' | 'runtime'): ZotzAgentTaskPriority {
  if (origin === 'ui') {
    return 'manual'
  }
  const source = args.telemetry?.launch_source
  return source === 'mobile' || source === 'cli' ? 'remote' : 'automation'
}

// Everything that would start the agent; without them the pane opens as a plain shell.
const AGENT_LAUNCH_KEYS = [
  'command',
  'commandDelivery',
  'startupCommandDelivery',
  'launchAgent',
  'agentLaunch',
  'launchConfig',
  'launchToken'
] as const

/** A canceled launch still spawns its pane (or it would retry), only without the agent. */
function withoutAgentLaunch(args: HoldableSpawnArgs): void {
  for (const key of AGENT_LAUNCH_KEYS) {
    Reflect.deleteProperty(args, key)
  }
  if (args.telemetry) {
    const { agent_kind: _agent, ...telemetry } = args.telemetry
    void _agent
    args.telemetry = telemetry
  }
}

/**
 * Waits for the memory governor before a new agent process starts (docs/zotz/PLAN.md §8c).
 * Reattaching a live session or restoring after a restart never waits: those are paced upstream.
 */
export function holdZotzAgentSpawn(
  args: HoldableSpawnArgs,
  origin: 'ui' | 'runtime'
): Promise<void> | undefined {
  const agent = launchedAgent(args)
  if (!launchQueue || !agent || args.spawnIntent !== undefined || args.sessionId) {
    return undefined
  }
  return launchQueue
    .admit({
      agent,
      priority: launchPriority(args, origin),
      paneKey: resolveEarlyPaneKey(args),
      label: args.worktreeId ?? agent,
      signal: args.signal
    })
    .then((admission) => {
      if (admission === 'canceled') {
        withoutAgentLaunch(args)
      }
    })
}
