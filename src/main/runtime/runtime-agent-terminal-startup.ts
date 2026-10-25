import type { SessionOptionValue } from '../../shared/native-chat-session-options'
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

/** No launch command could be built for a requested `startupAgent`. */
export class AgentLaunchUnbuildableError extends Error {}

type AgentTerminalPlanHost = {
  store: RuntimeStore | null | undefined
  hostIdentity: string
  toSessionOptions: (
    preferences: AgentLaunchPreferences | undefined
  ) => Record<string, SessionOptionValue> | undefined
}

/**
 * Every host terminal create passes here. An agent the host plans (requested or typed bare) is
 * quoted for the workspace's one runtime fact and spawns with it. A command the caller quoted keeps
 * the spawn's own shell rule unless the caller passes the fact it quoted with.
 */
export async function resolveAgentTerminalCreateOptions(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  host: AgentTerminalPlanHost
): Promise<TerminalCreateOptions> {
  const store = host.store ?? undefined
  // Why: raw shell commands like `codex exec` must remain user-authored shell.
  // Only unmanaged, repo-backed, bare agent launches get Settings defaults.
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
  // Before any early return: a host that cannot apply the requested shell must refuse rather than
  // spawn another one. Judged against the runtime this PTY's shell will come from.
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
    // Why: falling through unresolved would spawn a bare shell that can only time out waiting for
    // an agent. A caller-supplied launch contradicts the agent: `command` would be overwritten,
    // `resumeProviderSession` would pair resume identity with a fresh launch.
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

/**
 * The desktop-selected account env over the launch's plan, as a desktop launch's `accountEnv`
 * rides over it; what the caller itself passed (`env`, `accountEnv`) still wins.
 */
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
  // Why: `workspace.repo` is display metadata and may be a row from another host; the launch
  // shape must match the PTY route this scope already resolved.
  const isRemote = Boolean(workspace.connectionId)
  const forceLine = opts.startupPromptCarry === 'force-line'
  // A prompt this launch command cannot carry has nowhere to go from here — the create returns
  // options, not a live PTY — so refuse rather than spawn the agent and drop the text. `force-line`
  // keeps createAgentSession's clean launch instead.
  if (opts.startupPrompt && !forceLine && !agentPromptRidesLaunchCommand(agent)) {
    throw new Error(`Agent ${agent} does not take a startup prompt on its launch command.`)
  }
  const scope = {
    inputs: resolveAgentStartupPlanInputs({
      agent,
      settings,
      platform: runtime.platform,
      isRemote,
      ...(opts.agentArgs !== undefined ? { agentArgs: opts.agentArgs } : {}),
      shell: agentLaunchQuotingShell(runtime),
      sessionOptions: host.toSessionOptions(opts.launchPreferences),
      ...(opts.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {})
    }),
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
    // Why: an explicit agent that yields no plan would otherwise spawn a bare
    // shell that never reaches agent readiness.
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
