import type { ExecutionHostId } from '../shared/execution-host'
import type { ProjectHostSetup } from '../shared/project-types'
import type { RuntimeStatus } from '../shared/runtime-types'
import { PROJECT_HOST_SETUP_EXECUTION_HOST_RUNTIME_CAPABILITY } from '../shared/protocol-version'
import { hostFilterMatchesHostId, resolveHostFlagTarget } from './execution-host-flag'
import { RuntimeClientError, type RuntimeClient } from './runtime-client'

export async function resolveProjectSetupMutationHost(
  flags: Map<string, string | boolean>,
  client: RuntimeClient,
  setupId: string
): Promise<ExecutionHostId | undefined> {
  const host = await resolveHostFlagTarget(flags, client)
  if (!host) {
    return undefined
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(PROJECT_HOST_SETUP_EXECUTION_HOST_RUNTIME_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'Update Orca on the server to safely select a project setup execution host.'
    )
  }
  if (host.kind !== 'runtime') {
    return host.id
  }
  const response = await client.call<{ setups: ProjectHostSetup[] }>('projectHostSetup.list')
  const exact = response.result.setups.filter(
    (setup) => setup.id === setupId && setup.hostId === host.id
  )
  const matches = exact.length
    ? exact
    : response.result.setups.filter(
        (setup) => setup.id === setupId && hostFilterMatchesHostId(host, setup.hostId)
      )
  if (matches.length !== 1) {
    throw new RuntimeClientError(
      'invalid_argument',
      `Project setup host is missing or ambiguous: ${setupId}`
    )
  }
  return matches[0].hostId
}
