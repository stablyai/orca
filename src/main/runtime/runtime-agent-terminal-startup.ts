import type { SessionOptionValue } from '../../shared/native-chat/input/native-chat-session-options'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import {
  agentLaunchQuotingShell,
  remoteExecutionPlatform,
  type AgentLaunchRuntime
} from '../../shared/agent-launch-runtime'
import type { RuntimeStore } from './runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './runtime-terminal-contracts'
import { resolveBareAgentLaunchCommand } from './runtime-agent-launch-resolution'
import {
  buildExecutionHostAgentStartupPlan,
  planExecutionHostStartupWithPromptCandidate
} from '../opencode/opencode-model-startup-plan'
import { agentPromptRidesLaunchCommand } from '../../shared/tui-agent-startup'
import {
  launchHostProvesAgentInFront,
  nameLocalTypedLineShell
} from './agent-launch-typed-line-shell'
import { resolveTerminalStartupCwd } from '../../shared/terminal-startup-cwd'
import { resolveAgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import { agentStartedTelemetry } from '../agent-launch/agent-started-telemetry'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'
import {
  resolveLocalProjectRuntimeForWorktreeId,
  resolvePlainTerminalPtyOptions
} from '../local-project-runtime-resolution'
import {
  agentLaunchPlatformForScope,
  agentLaunchProjectRuntime,
  resolveAgentLaunchRuntime
} from './agent-launch-scope-runtime'
import { resolveQoderTerminalCommand } from './qoder-terminal-command-resolution'
import { resolveStartupShell } from '../../shared/tui-agent-startup-shell'
import { resolveWslSessionContext } from '../daemon/wsl-session-context'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { resolveWslHostAgentLaunchInputs } from './wsl-host-agent-terminal-launch'

/** No launch command could be built for a requested `startupAgent`. */
export class AgentLaunchUnbuildableError extends Error {}

type AgentTerminalPlanHost = {
  store: RuntimeStore | null | undefined
  hostIdentity: string
  toSessionOptions: (
    preferences: AgentLaunchPreferences | undefined
  ) => Record<string, SessionOptionValue> | undefined
}

/** Host-planned requested/bare agents use the workspace's resolved runtime; caller-quoted commands keep spawn shell rules unless given their quoting runtime. */
export async function resolveAgentTerminalCreateOptions(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  host: AgentTerminalPlanHost
): Promise<TerminalCreateOptions> {
  const store = host.store ?? undefined
  // Preserve raw commands such as codex exec; Settings defaults apply only to unmanaged repo-backed bare agents.
  const callerSuppliedLaunch =
    opts.env ||
    opts.launchConfig ||
    opts.launchAgent ||
    opts.startupCommandDelivery ||
    opts.claudeAgentTeamsSourceCommand
  const plannedAgent =
    opts.startupAgent ??
    (!callerSuppliedLaunch && store && opts.command && workspace.repo
      ? resolveBareAgentLaunchCommand({
          command: opts.command,
          settings: store.getSettings(),
          platform: agentLaunchPlatformForScope(store, workspace),
          isRemote: Boolean(workspace.connectionId)
        })
      : null)
  const launchAgent = plannedAgent ?? opts.launchAgent
  // Refuse unsupported requested shells before any return, using the runtime that will spawn this PTY.
  const shellRefusal = terminalShellOverrideRefusal({
    shellOverride: opts.shellOverride,
    connectionId: workspace.connectionId,
    platform: process.platform,
    projectRuntime:
      opts.shellOverride && store
        ? plannedAgent || opts.launchRuntime
          ? agentLaunchProjectRuntime(store, workspace, plannedAgent ?? opts.launchAgent)
          : resolveLocalProjectRuntimeForWorktreeId(store, workspace.id)
        : undefined,
    cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
    workspacePath: workspace.path
  })
  if (shellRefusal) {
    throw shellRefusal
  }
  if (opts.startupAgent) {
    // Missing plans must not fall through to a shell that never becomes ready; supplied commands/resume identities contradict fresh launch plans.
    if (callerSuppliedLaunch || opts.command || opts.resumeProviderSession) {
      throw new Error(
        `startupAgent ${opts.startupAgent} cannot combine with a caller-supplied launch.`
      )
    }
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    if (!isTuiAgentEnabled(opts.startupAgent, store.getSettings().disabledTuiAgents)) {
      throw new Error(`Agent ${opts.startupAgent} is disabled. Choose an enabled agent.`)
    }
  }
  if (!launchAgent || !store) {
    return opts
  }
  const runtime =
    opts.launchRuntime ??
    (plannedAgent
      ? resolveAgentLaunchRuntime(store, workspace, opts.shellOverride, plannedAgent)
      : undefined)
  const launch =
    plannedAgent && runtime
      ? await buildRuntimeAgentTerminalStartupOptions(
          workspace,
          opts,
          plannedAgent,
          store.getSettings(),
          runtime,
          host
        )
      : opts
  if (!launch.launchAgent) {
    return launch
  }
  const qoderLaunch = await resolveQoderLaunchCommand(launch, workspace, store, runtime)
  return runtime ? { ...qoderLaunch, launchRuntime: runtime } : qoderLaunch
}

/** Desktop-selected account env overrides the launch plan; explicit caller env/accountEnv still wins. */
export function withHostAccountLaunchEnv(
  requested: Pick<TerminalCreateOptions, 'env' | 'accountEnv'>,
  launch: TerminalCreateOptions,
  accountEnv: Readonly<Record<string, string>>
): TerminalCreateOptions {
  if (Object.keys(accountEnv).length === 0) {
    return launch
  }
  return {
    ...launch,
    env: {
      ...launch.env,
      ...accountEnv,
      ...requested.env,
      ...requested.accountEnv
    }
  }
}

async function buildRuntimeAgentTerminalStartupOptions(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  agent: TuiAgent,
  settings: ReturnType<RuntimeStore['getSettings']>,
  runtime: AgentLaunchRuntime,
  host: AgentTerminalPlanHost
): Promise<TerminalCreateOptions> {
  // Repo display metadata may belong to another host; use the already-resolved PTY route for launch.
  const isRemote = Boolean(workspace.connectionId)
  const forceLine = opts.startupPromptCarry === 'force-line'
  // Create has no live PTY for later prompt delivery; refuse uncarryable text. force-line preserves createAgentSession's clean launch.
  if (opts.startupPrompt && !forceLine && !agentPromptRidesLaunchCommand(agent)) {
    throw new Error(`Agent ${agent} does not take a startup prompt on its launch command.`)
  }
  const scope = {
    inputs: resolveWslHostAgentLaunchInputs(
      resolveAgentStartupPlanInputs({
        agent,
        settings,
        platform: runtime.platform,
        isRemote,
        ...(opts.agentArgs !== undefined ? { agentArgs: opts.agentArgs } : {}),
        shell: agentLaunchQuotingShell(runtime),
        sessionOptions: host.toSessionOptions(opts.launchPreferences),
        ...(opts.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {})
      }),
      opts.env?.PATH
    ),
    prompt: opts.startupPrompt ?? '',
    cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
    hostIdentity: host.hostIdentity,
    signal: opts.signal
  }
  // TEMPORARY (createAgentSession parity, removed with force-line): a draft skips the carry rule.
  const { plan: startupPlan, promptCarried } =
    opts.startupPromptDelivery === 'draft' || forceLine
      ? {
          plan: await buildExecutionHostAgentStartupPlan({
            ...scope,
            promptDelivery: opts.startupPromptDelivery
          }),
          promptCarried: agentPromptRidesLaunchCommand(agent)
        }
      : await planExecutionHostStartupWithPromptCandidate({
          ...scope,
          host: {
            shellName: nameLocalTypedLineShell({
              isRemote,
              ...(runtime.pty.shellOverride ? { shellOverride: runtime.pty.shellOverride } : {})
            }),
            provesAgentInFront: launchHostProvesAgentInFront({
              isRemote,
              launchPlatform: runtime.platform
            })
          }
        })
  if (!startupPlan) {
    // Explicit agents without plans must not become bare shells that never reach readiness.
    if (opts.startupAgent) {
      throw new AgentLaunchUnbuildableError(
        `Could not build launch command for ${opts.startupAgent}.`
      )
    }
    return opts
  }
  if (opts.startupPrompt) {
    opts.onStartupPromptCarry?.(promptCarried)
  }

  // Account routing rides over the plan's own env, as a local launch's auth patch does.
  const env = opts.accountEnv ? { ...startupPlan.env, ...opts.accountEnv } : startupPlan.env
  return {
    ...opts,
    command: startupPlan.launchCommand,
    ...(env ? { env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    startupCommandDelivery: startupPlan.startupCommandDelivery,
    // A bare command the user typed stays out of launch accounting, as before.
    ...(opts.startupAgent ? { telemetry: agentStartedTelemetry(agent, opts.launchSource) } : {})
  }
}

/** Qoder ships under two command names; the launch runs whichever the machine that runs it has. */
function resolveQoderLaunchCommand(
  launch: TerminalCreateOptions,
  workspace: TerminalWorkspaceLaunchScope,
  store: RuntimeStore,
  runtime: AgentLaunchRuntime | undefined
): Promise<TerminalCreateOptions> {
  if (launch.launchAgent !== 'qoder') {
    return Promise.resolve(launch)
  }
  if (workspace.connectionId) {
    return resolveQoderTerminalCommand(launch, {
      connectionId: workspace.connectionId,
      shell: resolveStartupShell(remoteExecutionPlatform(workspace.path))
    })
  }
  // A command its caller quoted runs under the spawn's own rule; its tokens are what is searched.
  const fact = runtime ?? {
    platform: agentLaunchPlatformForScope(store, workspace),
    pty: resolvePlainTerminalPtyOptions(
      store,
      store.getSettings(),
      workspace.id,
      launch.shellOverride
    )
  }
  // Where the process runs: a `\\wsl$` cwd first, then a WSL shell, as the spawn decides it.
  const wsl = resolveWslSessionContext({
    cwd: resolveTerminalStartupCwd(workspace.path, launch.cwd) ?? workspace.path,
    shellOverride: fact.pty.shellOverride,
    terminalWindowsWslDistro: fact.pty.terminalWindowsWslDistro
  })
  return resolveQoderTerminalCommand(launch, {
    context: wsl ? { wslDistro: wsl.distro } : {},
    shell: agentLaunchQuotingShell(fact)
  })
}
