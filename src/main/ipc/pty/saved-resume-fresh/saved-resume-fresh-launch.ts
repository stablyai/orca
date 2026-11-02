import { agentHookServer } from '../../../agent-hooks/server'
import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { buildAgentRecipeFreshLaunch } from '../../../../shared/tui-agent-resume-startup'
import { resolveResumeLaunchRecipe } from '../../../../shared/tui-agent-launch-defaults'
import {
  SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../../../shared/setup-agent-sequencing'
import { withOpenCodePrivateServerWhenNeeded } from '../../../opencode/opencode-pty-launch'
import {
  decorateAgentLaunchCommand,
  resolveAgentLaunchShell
} from '../agent-launch-command-decoration'
import type { ResumeSpawnAdmission } from '../host-env/saved-resume-admission'
import type { PtySpawnOperationState } from '../spawn-operation-state'
import { isWslTerminalSpawn } from '../wsl-terminal-spawn'
import { probeSavedResumeStore } from './store-presence'

// Pi resumes an exact session file named in its arguments, so main can check it before spawn.
// Agents whose store the pane's env selects check from inside the invocation (saved-restore-arm.ts).
const PRE_SPAWN_AGENTS = new Set(['pi'])
export const SEQUENCED_STARTUP_ENV = [
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV,
  SETUP_AGENT_SEQUENCE_SETUP_SCRIPT_ENV
]

export type SavedResumeLaunchFacts = {
  shellOverride: string | undefined
  /** Lanes that report their own copy of the launch recipe update it here. */
  applyLaunchConfig?: (launchConfig: SleepingAgentLaunchConfig) => void
}

/** Thrown inside a held conversation claim so it unwinds; the fresh agent never owns that
 *  conversation. Requests that joined the claim receive this verdict and start fresh too. */
export class SavedResumeStartedFresh extends Error {
  constructor(readonly replaced: { agent: string; providerSession: AgentProviderSessionMetadata }) {
    super('saved_resume_started_fresh')
  }
}

type FreshEligibility = { agent: ResumableTuiAgent; providerSession: AgentProviderSessionMetadata }

function eligibleSavedRestore(
  ctx: PtySpawnOperationState,
  launch: SavedResumeLaunchFacts | undefined
): FreshEligibility | null {
  const args = ctx.args
  const agent = args.launchAgent
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  const env = ctx.spawnOptions.env ?? {}
  return launch &&
    args.resumeOrigin === 'saved' &&
    providerSession &&
    agent &&
    isResumableTuiAgent(agent) &&
    PRE_SPAWN_AGENTS.has(agent) &&
    !args.connectionId &&
    ctx.expectedWslDistro === null &&
    !isWslTerminalSpawn(launch.shellOverride, ctx.cwd) &&
    ctx.spawnOptions.command &&
    !SEQUENCED_STARTUP_ENV.some((key) => env[key] !== undefined || args.env?.[key] !== undefined)
    ? { agent, providerSession }
    : null
}

/** The one place a saved restore may become a fresh launch: its latest launch saw no lifecycle
 *  event since its seed, and the store its agent reads definitively lacks the conversation. The
 *  fresh command is rebuilt from the saved recipe; a typed command never reaches here. */
export async function startSavedResumeFreshWhenMissing(
  ctx: PtySpawnOperationState,
  paneKey: string | null,
  launch: SavedResumeLaunchFacts | undefined,
  admission: ResumeSpawnAdmission | null
): Promise<boolean> {
  const eligible = eligibleSavedRestore(ctx, launch)
  if (!eligible || !launch || !paneKey || admission?.verdict !== 'admitted') {
    return false
  }
  const { agent, providerSession } = eligible
  const stillSeed = agentHookServer.captureLaunchSeed(paneKey, agent, providerSession)
  if (!stillSeed) {
    return false
  }
  const recipe = admission.sourceRecord?.launchConfig ?? ctx.args.launchConfig
  const presence = await probeSavedResumeStore({
    agent,
    providerSession,
    roots: {},
    cwd: ctx.cwd,
    recipeArgs: `${recipe?.agentCommand ?? ''} ${recipe?.agentArgs ?? ''}`,
    settings: ctx.deps.getSettings?.()
  })
  return (
    presence === 'missing' &&
    stillSeed() &&
    // Anything the pane reported while the store was read means the agent ran; resume as asked.
    applyFreshLaunch(ctx, launch, agent, recipe, stillSeed)
  )
}

/** A saved restore that joined a claim whose creator started fresh applies that verdict to its
 *  own request; the creator consumed the seed, so it never runs the replaced resume. Any other
 *  joiner, such as an explicit resume of the same conversation, keeps its own command. */
export async function startJoinedSavedResumeFresh(
  ctx: PtySpawnOperationState,
  launch: SavedResumeLaunchFacts | undefined,
  verdict: SavedResumeStartedFresh
): Promise<'started-fresh' | 'not-a-saved-restore' | 'failed'> {
  const eligible = eligibleSavedRestore(ctx, launch)
  if (
    !eligible ||
    !launch ||
    eligible.agent !== verdict.replaced.agent ||
    !agentProviderSessionsEqual(
      eligible.agent,
      eligible.providerSession,
      verdict.replaced.providerSession
    )
  ) {
    return 'not-a-saved-restore'
  }
  return (await applyFreshLaunch(ctx, launch, eligible.agent, ctx.args.launchConfig, () => true))
    ? 'started-fresh'
    : 'failed'
}

function effectiveLaunchEnv(ctx: PtySpawnOperationState): Record<string, string> {
  const launchEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries({ ...process.env, ...ctx.spawnOptions.env })) {
    if (value !== undefined && !ctx.spawnOptions.envToDelete?.includes(key)) {
      launchEnv[key] = value
    }
  }
  return launchEnv
}

/** The saved recipe's fresh launch, decorated as this spawn decorates its own command. */
export async function buildSavedResumeFreshCommand(
  ctx: PtySpawnOperationState,
  launch: SavedResumeLaunchFacts,
  agent: ResumableTuiAgent,
  recipe: SleepingAgentLaunchConfig | undefined
) {
  const env = ctx.spawnOptions.env ?? {}
  const settings = ctx.deps.getSettings?.()
  const shell = resolveAgentLaunchShell(
    false,
    false,
    launch.shellOverride ?? settings?.terminalWindowsShell
  )
  const fresh = buildAgentRecipeFreshLaunch({
    agent,
    cmdOverrides: settings?.agentCmdOverrides ?? {},
    platform: process.platform,
    shell,
    permissionSettings: settings,
    ...resolveResumeLaunchRecipe(recipe)
  })
  if (!fresh) {
    return null
  }
  const decorated = decorateAgentLaunchCommand({
    command:
      env.ORCA_OPENCODE_PLUGIN_API === 'v2'
        ? withOpenCodePrivateServerWhenNeeded(fresh.command, shell, effectiveLaunchEnv(ctx))
        : fresh.command,
    env,
    envToDelete: ctx.spawnOptions.envToDelete ?? [],
    cwd: ctx.cwd,
    shell,
    connectionId: undefined,
    executesOnThisHost: true,
    shellOverride: launch.shellOverride
  })
  const command = decorated.command ? await decorated.command : decorated.launchCommand
  return command ? { fresh, shell, command, launchCommand: decorated.launchCommand } : null
}

async function applyFreshLaunch(
  ctx: PtySpawnOperationState,
  launch: SavedResumeLaunchFacts,
  agent: ResumableTuiAgent,
  recipe: SleepingAgentLaunchConfig | undefined,
  stillCurrent: () => boolean
): Promise<boolean> {
  const built = await buildSavedResumeFreshCommand(ctx, launch, agent, recipe)
  if (!built || !stillCurrent()) {
    return false
  }
  const args = ctx.args
  args.command = built.fresh.command
  args.launchConfig = built.fresh.launchConfig
  delete args.resumeProviderSession
  ctx.launchCommand = built.launchCommand
  ctx.spawnOptions.command = built.command
  launch.applyLaunchConfig?.(built.fresh.launchConfig)
  return true
}

/** After the fresh agent spawned: forget exactly the seed and saved record it replaced. */
export function forgetStartedFreshResume(
  paneKey: string | null,
  admission: ResumeSpawnAdmission | null
): void {
  if (!paneKey || admission?.verdict !== 'admitted') {
    return
  }
  try {
    agentHookServer.forgetRefusedPaneResume(paneKey, admission.refused)
  } catch (error) {
    // The fresh agent already runs; the next restore re-derives from whatever row remains.
    console.warn('[pty] could not forget a resume that started fresh', error)
  }
}
