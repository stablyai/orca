import type { ExecutionHostId } from '../../shared/execution-host'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { runWithPerforceSettings } from '../../shared/perforce/p4-settings-context'
import {
  dispatchPerforceOperation,
  type PerforceOperationName
} from '../../shared/perforce/perforce-operations'
import {
  normalizePerforceSettings,
  perforceSettingsOnHost,
  type PerforceSettings
} from '../../shared/perforce/perforce-settings'
import type { PerforceBackend } from '../../shared/perforce/perforce-backend'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from '../providers/execution-host-provider-dispatch'
import { resolvePerforceBackend } from '../perforce/perforce-ssh-backend'
import {
  generatePerforceDescription,
  type PerforceDescriptionChangelist
} from '../perforce/perforce-description-generation'
import type { CommitMessageAgentEnvironmentResolvers } from '../text-generation/commit-message-agent-environment'
import type { GenerateCommitMessageResult } from '../text-generation/commit-message-text-generation'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimePerforceCopyCommands } from './runtime-perforce-copy-commands'

type RuntimePerforceSettingsSource = Partial<
  Pick<GlobalSettings, 'perforce' | 'defaultTuiAgent' | 'agentCmdOverrides' | 'disabledTuiAgents'>
>

export type RuntimePerforceCommandHost = {
  resolveRuntimeFileTarget(selector: string): Promise<{
    worktree: { path: string }
    executionHostId: ExecutionHostId
  }>
  getRuntimeSettings(): RuntimePerforceSettingsSource
  getCommitMessageAgentEnvironment?(): CommitMessageAgentEnvironmentResolvers | undefined
}

/** A client's agent choices for an AI description; unset fields fall back to this host's settings. */
export type PerforceDescriptionRequest = {
  settings?: unknown
  changelist: PerforceDescriptionChangelist
  filePaths: string[]
  agentCmdOverrides?: Record<string, string>
  defaultTuiAgent?: TuiAgent | null
}

function knownAgentOverrides(raw: Record<string, string>): GlobalSettings['agentCmdOverrides'] {
  const overrides: GlobalSettings['agentCmdOverrides'] = {}
  for (const [agent, command] of Object.entries(raw)) {
    if (isTuiAgent(agent)) {
      overrides[agent] = command
    }
  }
  return overrides
}

/**
 * Where p4 runs for a workspace on `hostId`: null for this host, else the SSH target it reaches over
 * the relay. A `runtime:` host belongs to another Orca server and is never dispatched from here.
 */
export function perforceConnectionIdForHost(hostId: ExecutionHostId): string | null {
  const route = resolveGitRouteForHost(hostId)
  if (route.kind === 'runtime') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route.kind === 'ssh' ? route.connectionId : null
}

export function perforceBackendForHost(hostId: ExecutionHostId): PerforceBackend {
  return resolvePerforceBackend(perforceConnectionIdForHost(hostId))
}

/** A request's Perforce settings on this server: the client's, with this server's machine-specific ones. */
export function perforceSettingsForRequest(
  clientSettings: unknown,
  hostPerforce: GlobalSettings['perforce'] | undefined
): PerforceSettings {
  return perforceSettingsOnHost(clientSettings, normalizePerforceSettings(hostPerforce))
}

/** The runtime's `perforce.*` methods: the same operations as desktop IPC, for workspaces this host owns. */
export class RuntimePerforceCommands {
  constructor(private readonly host: RuntimePerforceCommandHost) {}

  async runPerforceOperation(
    worktreeSelector: string,
    operation: PerforceOperationName,
    params: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const backend = perforceBackendForHost(target.executionHostId)
    return runWithPerforceSettings(
      perforceSettingsForRequest(params.settings, this.host.getRuntimeSettings().perforce),
      () => dispatchPerforceOperation(backend, operation, target.worktree.path, params)
    )
  }

  async generatePerforceDescription(
    worktreeSelector: string,
    request: PerforceDescriptionRequest
  ): Promise<GenerateCommitMessageResult> {
    const target = await this.host.resolveRuntimeFileTarget(worktreeSelector)
    const connectionId = perforceConnectionIdForHost(target.executionHostId)
    // Why: a workspace on a WSL path runs its description agent inside that distro, as Git's does.
    const wslDistro = connectionId ? undefined : parseWslUncPath(target.worktree.path)?.distro
    const host = this.host.getRuntimeSettings()
    const perforce = perforceSettingsForRequest(request.settings, host.perforce)
    const settings = {
      defaultTuiAgent:
        request.defaultTuiAgent !== undefined
          ? request.defaultTuiAgent
          : (host.defaultTuiAgent ?? null),
      agentCmdOverrides: request.agentCmdOverrides
        ? knownAgentOverrides(request.agentCmdOverrides)
        : (host.agentCmdOverrides ?? {}),
      ...(host.disabledTuiAgents ? { disabledTuiAgents: host.disabledTuiAgents } : {})
    }
    return runWithPerforceSettings(perforce, () =>
      generatePerforceDescription({
        settings,
        perforce,
        backend: resolvePerforceBackend(connectionId),
        cwd: target.worktree.path,
        changelist: request.changelist,
        filePaths: request.filePaths,
        agentHost: connectionId
          ? { kind: 'ssh', connectionId }
          : {
              kind: 'local',
              ...(wslDistro ? { wslDistro } : {}),
              agentEnvironment: this.host.getCommitMessageAgentEnvironment?.()
            }
      })
    )
  }
}

export type RuntimePerforceCommandSurface = {
  runPerforceOperation: RuntimePerforceCommands['runPerforceOperation']
  generatePerforceDescription: RuntimePerforceCommands['generatePerforceDescription']
  runPerforceCopyOperation: RuntimePerforceCopyCommands['runPerforceCopyOperation']
  runPerforceCopyOperationOnRepo: RuntimePerforceCopyCommands['runPerforceCopyOperationOnRepo']
}

export function installRuntimePerforceCommandSurface(
  target: RuntimePerforceCommandSurface,
  owners: { workspaces: RuntimePerforceCommands; copies: RuntimePerforceCopyCommands }
): void {
  const { workspaces, copies } = owners
  Object.assign(target, {
    runPerforceOperation: workspaces.runPerforceOperation.bind(workspaces),
    generatePerforceDescription: workspaces.generatePerforceDescription.bind(workspaces),
    runPerforceCopyOperation: copies.runPerforceCopyOperation.bind(copies),
    runPerforceCopyOperationOnRepo: copies.runPerforceCopyOperationOnRepo.bind(copies)
  })
}
