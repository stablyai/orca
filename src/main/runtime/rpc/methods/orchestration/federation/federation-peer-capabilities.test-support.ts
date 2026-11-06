import {
  ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
  ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../../../orca-runtime'

/** Capabilities a simulated older execution host leaves out of its status.get. */
function withheldPeerCapabilities(host: {
  newCapabilities: boolean
  durableRelease: boolean
  autoRelease: boolean
}): ReadonlySet<string> {
  return new Set([
    ...(host.newCapabilities
      ? []
      : [
          ORCHESTRATION_FEDERATION_STRUCTURED_READ_RUNTIME_CAPABILITY,
          ORCHESTRATION_FEDERATION_FLEET_SNAPSHOT_RUNTIME_CAPABILITY
        ]),
    ...(host.newCapabilities && host.durableRelease
      ? []
      : [ORCHESTRATION_FEDERATION_RELEASE_ARCHIVE_RUNTIME_CAPABILITY]),
    ...(host.autoRelease ? [] : [ORCHESTRATION_WORKER_AUTO_RELEASE_RUNTIME_CAPABILITY])
  ])
}

export function olderPeerStatusResponse(
  runtime: OrcaRuntimeService,
  host: Parameters<typeof withheldPeerCapabilities>[0]
) {
  const status = runtime.getStatus()
  const withheld = withheldPeerCapabilities(host)
  return {
    id: 'status',
    ok: true as const,
    result: {
      ...status,
      capabilities: status.capabilities?.filter((capability) => !withheld.has(capability))
    },
    _meta: { runtimeId: runtime.getRuntimeId() }
  }
}
