import type { BrowserNetworkExecutionHost } from '../../shared/browser-client-host-protocol'
import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { ProjectExecutionRuntimeResolution } from '../../shared/project-execution-runtime'
import type { SshConnectionState } from '../../shared/ssh-types'

type RuntimeBrowserNetworkExecutionHostInput = {
  runtimeId: string
  runtimeRevision: number
  executionHostId: ExecutionHostId
  projectRuntime?: ProjectExecutionRuntimeResolution
  sshState?: SshConnectionState
}

export function resolveRuntimeBrowserNetworkExecutionHost(
  input: RuntimeBrowserNetworkExecutionHostInput
): BrowserNetworkExecutionHost {
  const host = parseExecutionHostId(input.executionHostId)
  if (host?.kind === 'local') {
    if (input.projectRuntime?.status === 'repair-required') {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
    if (input.projectRuntime?.runtime.kind === 'wsl') {
      return {
        kind: 'wsl',
        runtimeId: input.runtimeId,
        revision: input.runtimeRevision,
        distro: input.projectRuntime.runtime.distro
      }
    }
    return {
      kind: 'native',
      runtimeId: input.runtimeId,
      revision: input.runtimeRevision
    }
  }
  if (host?.kind === 'ssh') {
    const state = input.sshState
    const connectionGeneration = state?.connectionGeneration
    if (
      state?.targetId !== host.targetId ||
      state.status !== 'connected' ||
      !state.providerEpoch ||
      typeof connectionGeneration !== 'number' ||
      !Number.isSafeInteger(connectionGeneration) ||
      connectionGeneration < 0
    ) {
      throw new Error('browser_tunnel_execution_host_unavailable')
    }
    return {
      kind: 'ssh',
      targetId: host.targetId,
      providerEpoch: state.providerEpoch,
      connectionGeneration
    }
  }
  throw new Error('browser_tunnel_execution_host_unavailable')
}
