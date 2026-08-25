import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  buildPiRpcWorkerDispatchEnvelope,
  buildPiRpcWorkerLaunchCommand,
  type PiRpcWorkerCliCommand,
  type PiRpcWorkerLaunchOptions
} from '../../../../shared/pi-rpc-worker-launch'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationCliCommand } from '../../orchestration/cli-command'
import { resolveTerminalOrchestrationCliCommand } from '../../orchestration/cli-command'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import type { TrustedPiRpcCliInvocation } from '../../orchestration/pi-rpc-cli-invocation'
import {
  createWorkerLaunchReceipt,
  type OrchestrationWorkerLaunchReceipt
} from './orchestration-worker-launch-preferences'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'
import type { WorkerEffect } from './orchestration-worker-topology'

export type PiRpcWorkerTransportRequest = PiRpcWorkerLaunchOptions & { devMode?: boolean }
export type PiRpcWorkerTransportLaunch = {
  cliCommand: PiRpcWorkerCliCommand
  cliInvocation: TrustedPiRpcCliInvocation
  command: string
  platform: NodeJS.Platform
}

export function assertPiRpcWorkerFederationPlacement(params: WorkerStartInput): void {
  if (params.on && params.agent === 'pi') {
    throw new OrchestrationError(
      'capability_unsupported',
      'Fresh Pi RPC workers are not supported through connected-server worker-start.'
    )
  }
}

export function validatePiRpcTerminalLaunch(
  runtime: OrcaRuntimeService,
  terminalHandle: string,
  usePiRpcTransport: boolean,
  launch: PiRpcWorkerTransportLaunch | undefined,
  devMode: boolean | undefined
): void {
  if (!usePiRpcTransport) {
    return
  }
  if (!launch) {
    throw new Error('pi_rpc_worker_topology_unsupported')
  }
  if (
    !devMode &&
    runtime.getTerminalOrchestrationCliCommand(terminalHandle) !== launch.cliCommand
  ) {
    throw new Error('pi_rpc_worker_cli_mismatch')
  }
}

export function buildOrchestrationWorkerDispatchInput(args: {
  piRpcLaunch?: PiRpcWorkerTransportLaunch
  taskId: string
  dispatchId: string
  taskSpec: string
  coordinatorHandle: string
  workerHandle: string
  capability: string
  devMode?: boolean
  legacyCliCommand: OrchestrationCliCommand
}): string {
  return args.piRpcLaunch
    ? buildPiRpcWorkerDispatchEnvelope({
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        workerHandle: args.workerHandle,
        capability: args.capability,
        taskSpec: args.taskSpec,
        cliCommand: args.piRpcLaunch.cliCommand
      })
    : buildDispatchPreamble({
        taskId: args.taskId,
        dispatchId: args.dispatchId,
        taskSpec: args.taskSpec,
        coordinatorHandle: args.coordinatorHandle,
        workerHandle: args.workerHandle,
        dispatchCapability: args.capability,
        devMode: args.devMode,
        cliCommand: args.legacyCliCommand
      })
}

export async function createExistingWorktreeWorkerTerminal(args: {
  runtime: OrcaRuntimeService
  worktree: Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>
  agent: TuiAgent
  launchPreferences?: AgentLaunchPreferences
  piRpc?: PiRpcWorkerTransportRequest
  taskId: string
  effects: WorkerEffect[]
}): Promise<{
  handle: string
  warning?: string
  piRpcLaunch?: PiRpcWorkerTransportLaunch
}> {
  const piRpcLaunch = args.piRpc
    ? resolvePiRpcWorkerTransportLaunch({
        runtime: args.runtime,
        workspace: args.worktree,
        request: args.piRpc
      })
    : undefined
  const terminal = await args.runtime.createTerminal(`id:${args.worktree.id}`, {
    ...(piRpcLaunch
      ? {
          command: piRpcLaunch.command,
          env: piRpcLaunch.cliInvocation.env,
          // Preserve Pi ownership for readiness, incarnation, archive, and release.
          launchAgent: 'pi' as const
        }
      : {
          // Agent ids are not always executable names (for example cursor).
          startupAgent: args.agent,
          ...(args.launchPreferences ? { launchPreferences: args.launchPreferences } : {})
        }),
    title: `worker-${args.taskId}`,
    surfaceOwner: false
  })
  args.effects.push({
    kind: 'terminal',
    role: 'agent',
    action: 'created',
    id: terminal.handle,
    surface: terminal.surface,
    warning: terminal.warning,
    ...(piRpcLaunch ? { transport: 'pi-rpc' as const } : {})
  })
  return {
    handle: terminal.handle,
    warning: terminal.warning,
    ...(piRpcLaunch ? { piRpcLaunch } : {})
  }
}

export function prepareOrchestrationWorkerStart(args: {
  params: WorkerStartInput
  createsWorktree: boolean
  runtime: OrcaRuntimeService
}): {
  agent: TuiAgent | undefined
  launchPreferences: AgentLaunchPreferences | undefined
  launchReceipt: OrchestrationWorkerLaunchReceipt
  usePiRpcTransport: boolean
  piRpcRequest: PiRpcWorkerTransportRequest | undefined
} {
  const { params } = args
  const usePiRpcTransport = params.agent === 'pi' && !params.terminal
  if (usePiRpcTransport && params.effort && !params.model) {
    throw new OrchestrationError('invalid_argument', '--effort requires --model.')
  }
  // Pi RPC options belong to the supervisor, not the Pi TUI launcher catalog.
  const prepared = prepareLocalWorkerStart({
    ...args,
    params: usePiRpcTransport ? { ...params, model: undefined, effort: undefined } : params
  })
  if (!usePiRpcTransport) {
    return {
      agent: prepared.agent,
      launchPreferences: prepared.launch.preferences,
      launchReceipt: prepared.launch.receipt,
      usePiRpcTransport,
      piRpcRequest: undefined
    }
  }
  return {
    agent: prepared.agent,
    launchPreferences: undefined,
    launchReceipt: createWorkerLaunchReceipt({
      agent: 'pi',
      model: params.model,
      effort: params.effort
    }),
    usePiRpcTransport,
    piRpcRequest: {
      ...(params.model ? { model: params.model } : {}),
      ...(params.effort ? { effort: params.effort } : {}),
      ...(params.devMode ? { devMode: true } : {})
    }
  }
}

export function resolvePiRpcWorkerTransportLaunch(args: {
  runtime: OrcaRuntimeService
  workspace: {
    id: string
    path: string
    repoId?: string
    hostId?: ExecutionHostId
    connectionId?: string | null
    executionHostId?: ExecutionHostId | null
  }
  request: PiRpcWorkerTransportRequest
}): PiRpcWorkerTransportLaunch {
  const { workspace } = args
  const parsedHost = parseExecutionHostId(
    workspace.hostId ??
      ('connectionId' in workspace || 'executionHostId' in workspace
        ? getRepoExecutionHostId(workspace)
        : undefined)
  )
  if (parsedHost && parsedHost.kind !== 'local') {
    throw new Error('pi_rpc_worker_topology_unsupported')
  }
  const connectionId = workspace.connectionId?.trim() || undefined
  if (connectionId) {
    throw new Error('pi_rpc_worker_topology_unsupported')
  }
  const worktreeId = workspace.id.includes('::')
    ? workspace.id
    : `${workspace.repoId ?? workspace.id}::${workspace.path}`
  const projectRuntime = args.runtime.resolveProjectRuntimeForWorktree(worktreeId)
  if (
    projectRuntime?.status === 'repair-required' ||
    (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl')
  ) {
    throw new Error('pi_rpc_worker_topology_unsupported')
  }
  const cliCommand = args.request.devMode
    ? 'orca-dev'
    : resolveTerminalOrchestrationCliCommand({
        connectionId: connectionId ?? null,
        isWsl: undefined,
        worktreeId,
        projectRuntime
      })
  const platform = resolvePiRpcWorkerPlatform({
    path: workspace.path,
    projectRuntime
  })
  if (platform !== process.platform) {
    throw new Error('pi_rpc_worker_topology_unsupported')
  }
  const cliInvocation = args.runtime.getPiRpcWorkerCliInvocation(cliCommand, workspace.path)
  return {
    cliCommand,
    cliInvocation,
    platform,
    command: buildPiRpcWorkerLaunchCommand({
      cliCommand,
      cliExecutable: cliInvocation.executable,
      cliArgsPrefix: cliInvocation.argsPrefix,
      platform,
      model: args.request.model,
      effort: args.request.effort
    })
  }
}

function resolvePiRpcWorkerPlatform(args: {
  path: string
  projectRuntime?: ProjectExecutionRuntimeResolution
}): NodeJS.Platform {
  if (args.projectRuntime?.status === 'resolved') {
    const runtime = args.projectRuntime.runtime
    if (runtime.kind === 'wsl') {
      return 'linux'
    }
    if (runtime.kind === 'windows-host') {
      return 'win32'
    }
    if (runtime.hostPlatform === 'darwin' || runtime.hostPlatform === 'linux') {
      return runtime.hostPlatform
    }
  }
  return isWslUncPath(args.path) ? 'linux' : process.platform
}
