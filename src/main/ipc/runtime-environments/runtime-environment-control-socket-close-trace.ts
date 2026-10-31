import { startSpan } from '../../observability/tracer'
import type { SharedControlSocketCloseRecord } from '../../../shared/remote-runtime/control/remote-runtime-shared-control-types'

/** One trace span per closed control socket, so a support bundle shows why a host reconnected. */
export function traceSharedControlSocketClose(
  environmentId: string,
  record: SharedControlSocketCloseRecord
): void {
  startSpan('remote-runtime.control-socket-close', {
    kind: 'client',
    attributes: { environmentId, ...record }
  }).end()
}
