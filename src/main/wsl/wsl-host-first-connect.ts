/** Before Add persists its record, removal/disable/startup cannot find the connection or detached holder. Every unsuccessful Add must release both here. */
import { errorMessage } from '../../shared/error-message'
import type { WslHostAddResult } from '../../shared/wsl-host-types'
import { OrcadHostUnsupportedError } from '../orcad/orcad-host-unavailable'
import type { WslHostConnector } from './wsl-host-service'
import { WslOrcadLaunchDeferredError } from './wsl-orcad-connection-errors'
import {
  WslDistroNotRegisteredError,
  WslDistroVersion1Error,
  wslUnsupportedDistroFixMessage
} from './wsl-distro-unsupported'
import { wslHostAddRefusal } from './wsl-host-add-admission'
import { RemoteNodeRuntimeSelfTestError } from '../ssh/orcad-remote-node-runtime-report'
import type { WslOrcadConnection } from './wsl-orcad-connection'

type WslHostAddRefusal = Extract<WslHostAddResult, { ok: false }>
type AddConnector = Pick<WslHostConnector, 'connect' | 'disconnect' | 'releaseHolder'>

export async function abandonWslHostAdd(connector: AddConnector, distro: string): Promise<void> {
  await connector.disconnect(distro).catch(() => {})
  await connector.releaseHolder(distro).catch(() => {})
}

/** `lateRefusal` is re-read once the connect lands: the setting can change while it runs. */
export async function connectForWslHostAdd(
  connector: AddConnector,
  distro: string,
  lateRefusal: () => WslHostAddRefusal | null
): Promise<{ connection: WslOrcadConnection } | WslHostAddRefusal> {
  let connection: WslOrcadConnection
  try {
    connection = await connector.connect(distro)
  } catch (error) {
    await abandonWslHostAdd(connector, distro)
    if (error instanceof WslOrcadLaunchDeferredError) {
      return { ok: false, kind: 'deferred', message: error.launch.reason }
    }
    if (error instanceof WslDistroVersion1Error) {
      return wslHostAddRefusal('unsupported-wsl1', 'wsl1', { distro: error.distro })
    }
    if (error instanceof WslDistroNotRegisteredError) {
      return wslHostAddRefusal('unsupported-distro', 'notRegistered', { distro: error.distro })
    }
    return {
      ok: false,
      kind: connectFailureKind(error),
      message: wslUnsupportedDistroFixMessage(error) ?? errorMessage(error)
    }
  }
  const refusal = lateRefusal()
  if (refusal) {
    await abandonWslHostAdd(connector, distro)
    return refusal
  }
  return { connection }
}

/** A distro Orca can't run in reads apart from a connect that may work on retry. */
function connectFailureKind(error: unknown): WslHostAddRefusal['kind'] {
  return error instanceof OrcadHostUnsupportedError ||
    error instanceof RemoteNodeRuntimeSelfTestError
    ? 'unsupported-distro'
    : 'failed'
}
