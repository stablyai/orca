/** R39: each ready control socket to a WSL host says which Orca installation it belongs to. */
import { getAppEnvironment } from '../../shared/app-environment'
import { ORCAD_DECLARE_CLIENT_METHOD } from '../../shared/orcad-peer-desktops-contract'
import { resolveEnvironment } from '../../shared/runtime-environment-store'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { wslHostClientInstanceId } from './wsl-host-client-instance'

const DECLARE_TIMEOUT_MS = 10_000

type ControlRequest = (
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<unknown>>

/** Sent on the control socket itself, so the server ties the tag to exactly that socket. */
export function declareWslHostClient(
  environmentId: string,
  request: ControlRequest,
  isWslHost: (environmentId: string) => boolean = isWslHostEnvironment
): void {
  if (!isWslHost(environmentId)) {
    return
  }
  void request(
    ORCAD_DECLARE_CLIENT_METHOD,
    { clientInstanceId: wslHostClientInstanceId() },
    DECLARE_TIMEOUT_MS
  )
    .then((response) => {
      // An older server lacks the method; it then has no peer check, so nothing reads the tag.
      if (!response.ok && response.error.code !== 'method_not_found') {
        console.warn('[wsl-hosts] The WSL host did not note this Orca:', response.error.message)
      }
    })
    .catch(() => {
      // A socket that dropped before the answer declares again on its next ready.
    })
}

function isWslHostEnvironment(environmentId: string): boolean {
  try {
    const environment = resolveEnvironment(getAppEnvironment().getPath('userData'), environmentId)
    return environment.orcadDeployment?.kind === 'wsl'
  } catch {
    return false
  }
}
