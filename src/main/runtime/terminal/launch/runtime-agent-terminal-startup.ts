import type { RuntimeAccountController } from '../../agent-session/environment/runtime-account-controller'
import { applyRemoteViewerLaunchEnv } from './remote-viewer-launch-env'
import type { SessionOptionValue } from '../../../../shared/native-chat/input/native-chat-session-options'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { AgentLaunchPreferences } from '../../../../shared/agent-session/lifecycle/operations/agent-session-host-authority'
import {
  agentLaunchQuotingShell,
  type AgentLaunchRuntime
} from '../../../../shared/agent-launch/startup/agent-launch-runtime'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { TerminalCreateOptions } from './terminal-create-options'
import {
  buildExecutionHostAgentStartupPlan,
  planExecutionHostStartupWithPromptCandidate
} from '../../../opencode/model-launch/opencode-model-startup-plan'
import {
  agentLaunchUnbuildableMessage,
  agentPromptRidesLaunchCommand
} from '../../../../shared/agent-launch/startup/tui-agent-startup'
import {
  launchHostProvesAgentInFront,
  nameLocalTypedLineShell
} from './agent-launch-typed-line-shell'
import { resolveTerminalStartupCwd } from '../../../../shared/shell/launch/terminal-startup-cwd'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { agentStartedTelemetry } from '../../../agent-launch/agent-started-telemetry'
import { terminalShellOverrideRefusal } from './terminal-shell-override-host-support'
import { resolvePlainTerminalProjectRuntime } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import { agentLaunchProjectRuntime, resolveAgentLaunchRuntime } from './agent-launch-scope-runtime'
import { assertTuiAgentLaunchEnabled } from '../../../agent-launch/disabled-agent-launch-refusal'
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
  host: AgentTerminalPlanHost,
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
): Promise<TerminalCreateOptions> {
  const store = host.store ?? undefined
  const callerSuppliedLaunch =
    opts.env ||
    opts.launchConfig ||
    opts.launchAgent ||
    opts.startupCommandDelivery ||
    opts.claudeAgentTeamsSourceCommand ||
    opts.nativeChatSignIn
  const plannedAgent = opts.startupAgent ?? null
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
          : resolvePlainTerminalProjectRuntime(
              store,
              workspace.id,
              workspace,
              opts.tabId,
              workspace.connectionId
            )
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
    assertTuiAgentLaunchEnabled(opts.startupAgent, store.getSettings().disabledTuiAgents)
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
          host,
          sessionOptions
        )
      : opts
  return runtime && launch.launchAgent ? { ...launch, launchRuntime: runtime } : launch
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
  host: AgentTerminalPlanHost,
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
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
        ...(opts.extraAgentArgs !== undefined ? { extraAgentArgs: opts.extraAgentArgs } : {}),
        shell: agentLaunchQuotingShell(runtime),
        sessionOptions: sessionOptions ?? host.toSessionOptions(opts.launchPreferences),
        ...(opts.suppressStartupUpdatePrompt ? { suppressStartupUpdatePrompt: true } : {})
      }),
      opts.env?.PATH
    ),
    prompt: opts.startupPrompt ?? '',
    cwd: resolveTerminalStartupCwd(workspace.path, opts.cwd) ?? workspace.path,
    shellPath: runtime.pty.shellOverride,
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
      throw new AgentLaunchUnbuildableError(agentLaunchUnbuildableMessage(opts.startupAgent))
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

export async function prepareHostAgentTerminalLaunch(
  workspace: TerminalWorkspaceLaunchScope,
  opts: TerminalCreateOptions,
  resolvedLaunch: TerminalCreateOptions,
  accounts: Pick<RuntimeAccountController, 'prepareHostAgentLaunch' | 'hostLaunchEnvFor'>
): Promise<TerminalCreateOptions> {
  // An SSH workspace's shell runs on that machine, where this distro's account paths mean nothing.
  if (workspace.connectionId) {
    return applyRemoteViewerLaunchEnv(resolvedLaunch, opts.terminalImageViewerSupported)
  }
  if (resolvedLaunch.launchAgent) {
    await accounts.prepareHostAgentLaunch(resolvedLaunch.launchAgent)
  }
  const hostLaunchEnv = accounts.hostLaunchEnvFor(resolvedLaunch.launchAgent)
  const launch = withHostAccountLaunchEnv(opts, resolvedLaunch, hostLaunchEnv)
  return applyRemoteViewerLaunchEnv(launch, opts.terminalImageViewerSupported)
}
